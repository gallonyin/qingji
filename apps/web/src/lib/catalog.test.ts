import Dexie,{liveQuery} from 'dexie';
import {it,expect,vi,afterEach} from 'vitest';
import {db,MyNoteDB,createNote,updateNote,putLocalNote,deleteLocalNote,clearLocalNotes,type Note} from './db';
afterEach(async()=>{await clearLocalNotes();await db.outbox.clear();vi.restoreAllMocks();});
it('目录更新与正文和 outbox 原子提交；单篇订阅不读取无关正文',async()=>{
 const a=await createNote(),b=await createNote();
 const seen=vi.fn();const subscription=liveQuery(()=>db.notes.get(a.id)).subscribe(seen);
 try{
  await vi.waitFor(()=>expect(seen).toHaveBeenCalledTimes(1));
  await updateNote(b.id,{content:'另外一篇正文'});
  await new Promise(resolve=>setTimeout(resolve,30));expect(seen).toHaveBeenCalledTimes(1);
  const previous=await db.notes.get(a.id);
  vi.spyOn(db.catalog,'bulkPut').mockRejectedValueOnce(new Error('storage full'));
  await expect(updateNote(a.id,{content:'不能部分保存'})).rejects.toThrow('storage full');
  expect(await db.notes.get(a.id)).toEqual(previous);
  expect((await db.outbox.where('entityId').equals(a.id).first())?.payload.content).toBe('');
  await updateNote(a.id,{content:'正文不会进入目录'.repeat(1000)});
  const summary=await db.catalog.get(a.id);expect(summary).not.toHaveProperty('content');expect(summary?.excerpt.length).toBeLessThanOrEqual(72);
  await deleteLocalNote(a.id);expect(await db.catalog.get(a.id)).toBeUndefined();
 }finally{subscription.unsubscribe();}
});
it('v3 原地升级保留正文、待同步草稿并分批生成目录',async()=>{
 const name='migration-'+crypto.randomUUID();const old=new Dexie(name);
 old.version(3).stores({notes:'id, parentId, updatedAt, deletedAt, favorite, *tags',outbox:'++id, &operationId, entityId, createdAt',conflicts:'++id, entityId, createdAt',attachments:'id, noteId, createdAt',meta:'key',recoveryDrafts:'id, createdAt'});
 const note:Note={id:'old',title:'旧文',content:'完整正文',parentId:null,tags:[],favorite:false,createdAt:1,updatedAt:1,deletedAt:null,version:3};
 await old.table('notes').bulkPut(Array.from({length:205},(_,i)=>({...note,id:String(i).padStart(4,'0')})));
 await old.table('outbox').put({operationId:'pending',entityId:'0000',payload:note,createdAt:1});old.close();
 const upgraded=new MyNoteDB(name);
 try{await upgraded.open();expect(await upgraded.catalog.count()).toBe(205);expect((await upgraded.notes.get('0000'))?.content).toBe(note.content);expect(await upgraded.outbox.count()).toBe(1);expect(await upgraded.catalog.get('0000')).not.toHaveProperty('content');}
 finally{upgraded.close();await Dexie.delete(name);}
});
