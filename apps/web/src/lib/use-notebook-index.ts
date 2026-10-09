import {t} from './i18n';
import {useEffect,useRef,useState} from 'react';
import type {NoteSummary} from './db';
import type {IndexRequest,IndexResponse} from './notebook-index';
const empty:IndexResponse={sequence:0,matches:[],backlinks:[],pending:0,total:0,reads:0};
export function useNotebookIndex(notes:NoteSummary[],query:string,title:string,enabled:boolean){
 const worker=useRef<Worker|null>(null),known=useRef(new Map<string,string>()),sequence=useRef(0),initialized=useRef(false);
 const [result,setResult]=useState<IndexResponse>(empty);
 useEffect(()=>{
  if(!enabled)return;
  let instance:Worker;
  try{instance=new Worker(new URL('./notebook-index.worker.ts',import.meta.url),{type:'module'});}
  catch{setResult({...empty,error:t("本地全文检索暂不可用")});return;}
  worker.current=instance;known.current.clear();initialized.current=false;
  instance.onmessage=(event:MessageEvent<IndexResponse>)=>{if(event.data.sequence===sequence.current)setResult(event.data);};
  instance.onerror=()=>setResult(previous=>({...previous,error:t("本地全文检索暂不可用")}));
  return ()=>{instance.terminate();worker.current=null;};
 },[enabled]);
 useEffect(()=>{
  const current=new Map(notes.map(note=>[note.id,note.indexToken]));
  const upserts=notes.filter(note=>known.current.get(note.id)!==note.indexToken).map(({id,indexToken})=>({id,indexToken}));
  const removed=[...known.current.keys()].filter(id=>!current.has(id));
  const message:IndexRequest={type:'refresh',reset:!initialized.current,upserts,removed};
  worker.current?.postMessage(message);known.current=current;initialized.current=true;
 },[notes,enabled]);
 useEffect(()=>{
  sequence.current++;setResult(previous=>({...previous,matches:[],backlinks:[]}));
  const message:IndexRequest={type:'query',sequence:sequence.current,query:query.trim(),title};
  const timer=window.setTimeout(()=>worker.current?.postMessage(message),query.trim()?180:0);
  return ()=>window.clearTimeout(timer);
 },[query,title,enabled]);
 return result;
}
