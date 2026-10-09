import {it,expect,vi} from 'vitest';
import {db,putLocalNote,clearLocalNotes,type Note} from './db';
import {linksIn,matchesNote,type IndexRequest,type IndexResponse} from './notebook-index';
it('Worker 增量更新、旧查询取消、删除和可复用索引，不把正文传回主线程',async()=>{
 await clearLocalNotes();await db.noteIndex.clear();
 const base:Note={id:'a',title:'标题',content:'深处的关键字 [[目标]] [[目标]]',parentId:null,tags:[],favorite:false,createdAt:1,updatedAt:1,deletedAt:null,version:1};
 expect(linksIn(base.content)).toEqual(['目标']);expect(matchesNote(base,'关键字')).toBe(true);
 await putLocalNote(base);await putLocalNote({...base,id:'b',content:'other'});
 const responses:IndexResponse[]=[];vi.stubGlobal('postMessage',(r:IndexResponse)=>responses.push(r));vi.stubGlobal('onmessage',null);
 await import('./notebook-index.worker');
 const send=async(data:IndexRequest)=>{await (globalThis as any).onmessage({data});};
 const settled=async(sequence:number,reads:number)=>{await vi.waitFor(()=>{const r=responses.at(-1)!;expect(r.sequence).toBe(sequence);expect(r.pending).toBe(0);expect(r.reads).toBeGreaterThanOrEqual(reads);});return responses.at(-1)!;};
 try{
  await send({type:'refresh',reset:true,upserts:await db.catalog.toArray(),removed:[]});
  await send({type:'query',sequence:1,query:'关键字',title:'目标'});
  const first=await settled(1,2);expect(first.matches).toEqual(['a']);expect(first.backlinks).toEqual(['a']);
  const before=first.reads;
  await putLocalNote({...base,content:'修改后的 needle [[新目标]]',version:2});
  await send({type:'refresh',reset:false,upserts:[(await db.catalog.get('a'))!],removed:[]});
  const edited=await settled(1,before+1);expect(edited.matches).toEqual([]);expect(edited.backlinks).toEqual([]);expect(edited.reads-before).toBe(1);
  await send({type:'query',sequence:2,query:'other',title:''});
  await send({type:'query',sequence:3,query:'needle',title:'新目标'});
  const latest=await settled(3,edited.reads+2);expect(latest.matches).toEqual(['a']);expect(latest.backlinks).toEqual(['a']);
  expect(JSON.stringify(latest)).not.toContain('修改后的');
  await send({type:'refresh',reset:false,upserts:[],removed:['a']});
  await vi.waitFor(()=>expect(responses.at(-1)?.backlinks).toEqual([]));
  expect(await db.noteIndex.get('b')).toBeDefined();
 }finally{await clearLocalNotes();await db.noteIndex.clear();vi.unstubAllGlobals();}
});
