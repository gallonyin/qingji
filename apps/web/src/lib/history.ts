import {db, putLocalNote, type Note} from './db';
import {fromServer} from './sync';

const apiBase=import.meta.env.VITE_API_URL?.replace(/\/$/,'') || '/api';
export type HistoryVersion={id:number;revision:number;createdAt:string;title:string;deleted:boolean};
async function request(path:string,init:RequestInit={}){
  const response=await fetch(apiBase+path,{...init,headers:{authorization:`Bearer ${localStorage.getItem('mynote:token')??''}`,'content-type':'application/json','x-vault-epoch':(await db.meta.get('vaultEpoch'))?.value??'',...init.headers}});
  const data=await response.json().catch(()=>({}));
  if(!response.ok){
    const messages:Record<string,string>={REVISION_CONFLICT:'笔记已有新修改，请同步后重新查看历史。',EPOCH_CHANGED:'服务器数据版本已变化，请同步后重试。',NOTE_IN_TRASH:'请先从回收站恢复笔记。',BACKUP_PROTECTED:'服务器正在备份或恢复，请稍后再试。',NOT_FOUND:'笔记或历史版本不存在。'};
    throw new Error(messages[data.error]??`历史版本请求失败（${response.status}）`);
  }
  return data;
}
export async function listHistory(noteId:string,before?:number):Promise<{versions:HistoryVersion[];hasMore:boolean}>{
  return request(`/notes/${noteId}/history${before?`?before=${before}`:''}`);
}
export async function getHistory(noteId:string,id:number):Promise<Note>{
  return fromServer((await request(`/notes/${noteId}/history/${id}`)).note);
}
export async function restoreHistory(noteId:string,id:number,revision:number):Promise<Note>{
  if(await db.outbox.where('entityId').equals(noteId).count())throw new Error('这篇笔记还有未同步修改，请先同步后再恢复。');
  if(await db.conflicts.where('entityId').equals(noteId).count())throw new Error('请先处理这篇笔记的同步冲突。');
  const data=await request(`/notes/${noteId}/history/${id}/restore`,{method:'POST',body:JSON.stringify({revision})});
  const restored=fromServer(data.note);
  await db.transaction('rw',db.notes, db.catalog,db.outbox,async()=>{
    // Another tab may have edited while the request was in flight; keep its outbox.
    if(!await db.outbox.where('entityId').equals(noteId).count())await putLocalNote(restored);
  });
  return restored;
}
