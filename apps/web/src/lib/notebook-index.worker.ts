import {db} from './db';
import {linksIn,matchesNote,type IndexRequest,type IndexResponse} from './notebook-index';

const desired=new Map<string,string>(),links=new Map<string,{indexToken:string;links:string[]}>();
const pending=new Set<string>(),matches=new Set<string>();
let sequence=0,query='',title='',reads=0,running=false,lastReport=0;
const ready=db.noteIndex.toArray().then(rows=>{for(const row of rows)links.set(row.id,row);});
function report(error?:string){
 const backlinks=[...desired].filter(([id,token])=>{const entry=links.get(id);return entry?.indexToken===token&&entry.links.includes(title);}).map(([id])=>id);
 const response:IndexResponse={sequence,matches:[...matches],backlinks,pending:pending.size,total:desired.size,reads,error};postMessage(response);
}
async function work(){
 if(running)return;running=true;
 try{
  await ready;
  while(pending.size){
   const ids=[...pending].slice(0,16);ids.forEach(id=>pending.delete(id));
   const scanQuery=query;
   const batch=await db.transaction('r',db.notes,db.catalog,async()=>({notes:await db.notes.bulkGet(ids),summaries:await db.catalog.bulkGet(ids)}));
   const changed=[];
   for(let i=0;i<ids.length;i++){
    const id=ids[i],note=batch.notes[i],summary=batch.summaries[i];reads++;
    if(!note||!summary||desired.get(id)!==summary.indexToken)continue;
    if(links.get(id)?.indexToken!==summary.indexToken){
     const entry={id,indexToken:summary.indexToken,links:note.deletedAt?[]:linksIn(note.content)};links.set(id,entry);changed.push(entry);
    }
    // A changed query never accepts results from an earlier scan.
    if(scanQuery===query){if(query&&matchesNote(note,query))matches.add(id);else matches.delete(id);}
   }
   if(changed.length)await db.noteIndex.bulkPut(changed);
   if(Date.now()-lastReport>200){report();lastReport=Date.now();}
   // Yield between small batches so new searches and invalidations can supersede work.
   await new Promise(resolve=>setTimeout(resolve,0));
  }
  report();
 }catch{report('本地全文检索暂不可用');}
 finally{running=false;}
}
onmessage=async(event:MessageEvent<IndexRequest>)=>{
 try{
  const message=event.data;await ready;
  if(message.type==='refresh'){
   const removed=new Set(message.removed);
   if(message.reset){const keep=new Set(message.upserts.map(row=>row.id));for(const id of links.keys())if(!keep.has(id))removed.add(id);desired.clear();matches.clear();pending.clear();}
   for(const id of removed){desired.delete(id);links.delete(id);pending.delete(id);matches.delete(id);}
   for(const row of message.upserts){desired.set(row.id,row.indexToken);matches.delete(row.id);if(query||links.get(row.id)?.indexToken!==row.indexToken)pending.add(row.id);}
   if(removed.size)await db.noteIndex.bulkDelete([...removed]);
  }else{
   const changed=query!==message.query;query=message.query;title=message.title;sequence=message.sequence;
   if(changed){matches.clear();pending.clear();for(const [id,token] of desired)if(query||links.get(id)?.indexToken!==token)pending.add(id);}
  }
  report();void work();
 }catch{report('本地全文检索暂不可用');}
};
