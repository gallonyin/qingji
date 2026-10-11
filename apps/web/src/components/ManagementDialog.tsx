import {useEffect,useRef,useState} from 'react';
import {t,useLocale,localizeMessage} from '../lib/i18n';
export type ManagementRequest={action:'createFolder'|'moveFolder'|'renameFolder'|'deleteFolder'|'moveNote'|'trashNote';path?:string;id?:string;title?:string;count?:number};
export function ManagementDialog({request,folders,onCancel,onSubmit}:{request:ManagementRequest;folders:string[];onCancel:()=>void;onSubmit:(value:{name:string;parent:string})=>Promise<void>}) {
  useLocale();
  const source=request.path??'',parts=source.split('/');
  const [name,setName]=useState(request.action==='createFolder'?'':parts.at(-1)??'');
  const [parent,setParent]=useState(request.action==='createFolder'?source:request.action==='moveNote'?source:parts.slice(0,-1).join('/'));
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const dialog=useRef<HTMLFormElement>(null);
  useEffect(()=>{const previous=document.activeElement as HTMLElement;dialog.current?.querySelector<HTMLElement>('input,select,button')?.focus();return()=>previous?.focus();},[]);
  const titles={createFolder:t('新建文件夹'),moveFolder:t('移动文件夹'),renameFolder:t('重命名文件夹'),deleteFolder:t('删除文件夹'),moveNote:t('移动笔记'),trashNote:t('移入回收站')};
  const deleting=request.action==='deleteFolder'||request.action==='trashNote';
  const options=folders.filter(p=>!(request.action==='moveFolder'||request.action==='renameFolder')||(p!==source&&!p.startsWith(source+'/')));
  return <div className="dialog-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)onCancel();}}>
    <form ref={dialog} className="input-dialog management-dialog" role="dialog" aria-modal="true" aria-labelledby="management-title" onKeyDown={event=>{
      if(event.key==='Escape'&&!busy){event.preventDefault();onCancel();}
      if(event.key==='Tab'){
        const items=[...event.currentTarget.querySelectorAll<HTMLElement>('input,select,button:not(:disabled)')];
        const first=items[0],last=items.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
      }
    }} onSubmit={async event=>{
      event.preventDefault();setBusy(true);setError('');
      try{await onSubmit({name:name.trim(),parent});onCancel();}catch(reason){setError(localizeMessage(reason instanceof Error?reason.message:String(reason)));setBusy(false);}
    }}>
      <h2 id="management-title">{titles[request.action]}</h2>
      {request.title&&<p className="management-subject">{request.title}</p>}
      {request.action==='deleteFolder'&&<p>{t('删除“{0}”及其子文件夹，{1} 篇笔记将移入回收站，可从回收站恢复。',source,request.count??0)}</p>}
      {request.action==='trashNote'&&<p>{t('笔记将移入回收站，可以恢复。')}</p>}
      {!deleting&&<>
        {request.action!=='moveNote'&&<label>{t('文件夹名称')}<input required maxLength={200} disabled={busy} value={name} onChange={e=>setName(e.target.value)}/></label>}
        {request.action!=='renameFolder'&&<label>{t('目标位置')}<select disabled={busy} value={parent} onChange={e=>setParent(e.target.value)}><option value="">{t('根目录')}</option>{options.map(p=><option key={p} value={p}>{p}</option>)}</select></label>}
      </>}
      {request.action!=='moveNote'&&request.action!=='trashNote'&&<small>{t('文件夹操作需要联网，会同步到其他设备。')}</small>}
      {error&&<p className="login-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" disabled={busy} onClick={onCancel}>{t('取消')}</button><button className={deleting?'danger primary':'primary'} disabled={busy} type="submit">{busy?t('处理中…'):deleting?t('移入回收站'):t('确定')}</button></div>
    </form>
  </div>;
}
