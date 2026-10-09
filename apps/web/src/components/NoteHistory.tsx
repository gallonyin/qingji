import {t, localizeMessage, useLocale, getLocale} from '../lib/i18n';
import {useEffect,useRef,useState} from 'react';
import {db,type Note} from '../lib/db';
import {getHistory,listHistory,restoreHistory,type HistoryVersion} from '../lib/history';

export function NoteHistory({note,onClose,onRestored}:{note:Note;onClose:()=>void;onRestored:()=>Promise<void>}){
  useLocale();
  const dialog=useRef<HTMLDialogElement>(null);
  const [versions,setVersions]=useState<HistoryVersion[]>([]);
  const [more,setMore]=useState(false);
  const [selected,setSelected]=useState<HistoryVersion|null>(null);
  const [preview,setPreview]=useState<Note|null>(null);
  const [error,setError]=useState('');
  const [loading,setLoading]=useState(true);
  const [restoring,setRestoring]=useState(false);
  const [confirm,setConfirm]=useState(false);
  const previewRequest=useRef(0);
  useEffect(()=>{
    dialog.current?.showModal();
    let closed=false;
    void listHistory(note.id).then(page=>{if(!closed){setVersions(page.versions);setMore(page.hasMore);}})
      .catch(e=>{if(!closed)setError(String(e.message));}).finally(()=>{if(!closed)setLoading(false);});
    return()=>{closed=true;};
  },[note.id]);
  async function choose(version:HistoryVersion){
    const request=++previewRequest.current;
    setSelected(version);setPreview(null);setConfirm(false);setError('');
    try{const next=await getHistory(note.id,version.id);if(request===previewRequest.current)setPreview(next);}
    catch(e){if(request===previewRequest.current)setError((e as Error).message);}
  }
  async function loadMore(){
    setLoading(true);setError('');
    try{const page=await listHistory(note.id,versions.at(-1)?.id);setVersions(v=>[...v,...page.versions]);setMore(page.hasMore);}
    catch(e){setError((e as Error).message);}finally{setLoading(false);}
  }
  async function restore(){
    if(!selected)return;
    setRestoring(true);setError('');
    try{
      const current=await db.notes.get(note.id);
      if(!current)throw new Error(t("笔记不存在，请同步后重试。"));
      // Use the revision at dialog opening so intervening edits cannot be silently replaced.
      if((current.serverVersion??current.version)!==(note.serverVersion??note.version))throw new Error(t("笔记已有新修改，请关闭历史窗口并重新打开。"));
      await restoreHistory(note.id,selected.id,note.serverVersion??note.version);
      await onRestored();onClose();
    }catch(e){setError((e as Error).message);setConfirm(false);}finally{setRestoring(false);}
  }
  return <dialog ref={dialog} className="history-dialog" aria-labelledby="history-title" onCancel={event=>{event.preventDefault();if(!restoring)onClose();}}>
    <header><div><h2 id="history-title">{t("笔记历史版本")}</h2><p>{note.title}</p></div><button aria-label={t("关闭历史版本")} disabled={restoring} onClick={onClose}>{t("关闭")}</button></header>
    <p className="history-hint">{t("记录已保存到服务器的版本。恢复会生成新版本，当前内容仍可在历史中找回。附件文件不随正文回退。")}</p>
    {error&&<p role="alert" className="backup-error">{localizeMessage(error)}</p>}
    <div className="history-layout"><nav aria-label={t("历史版本列表")}>
      {versions.map(version=><button key={version.id} className={selected?.id===version.id?'selected':''} disabled={restoring} onClick={()=>void choose(version)}>
        <b>{t("版本 {0}{1}", version.revision, version.deleted?t(" · 回收站"):'')}</b><time>{new Date(version.createdAt).toLocaleString(getLocale())}</time><span>{version.title}</span>
      </button>)}
      {loading&&<p>{t("读取中…")}</p>}{!loading&&!versions.length&&<p>{t("暂无历史记录。下一次同步保存后会产生版本。")}</p>}
      {more&&<button disabled={loading||restoring} onClick={()=>void loadMore()}>{t("加载更早版本")}</button>}
    </nav><section aria-label={t("历史内容预览")}>
      {preview?<><h3>{preview.title}</h3><p className="muted">{preview.parentId||t("根目录")}{preview.tags.length?` · ${preview.tags.join('、')}`:''}</p><pre>{preview.content||t("（空白笔记）")}</pre></>:<p>{selected?t("正在读取内容…"):t("选择左侧版本，查看当时的内容。")}</p>}
    </section></div>
    <footer>{confirm?<><span>{t("恢复为版本 {0} 的内容？当前版本会保留。", selected?.revision)}</span><button disabled={restoring} onClick={()=>setConfirm(false)}>{t("取消")}</button><button disabled={restoring} onClick={()=>void restore()}>{restoring?t("恢复中…"):t("确认恢复")}</button></>:<button disabled={!preview||loading||restoring||!!note.deletedAt} onClick={()=>setConfirm(true)}>{t("恢复此版本")}</button>}
    </footer>
  </dialog>;
}
