import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { MarkdownPreview } from "./components/MarkdownPreview";
import {
  ArchiveRestore, ChevronsUpDown, Cloud, FilePlus2, FolderInput, Link2, LogOut,
  Menu, Paperclip, PanelRightClose, PanelRightOpen, Search, Star, Tags, Trash2,
  RotateCcw, UserRound, WifiOff, X, Zap, Settings, Github
} from "lucide-react";
import { SettingsPage, BrandMark } from "./components/SettingsPage";
import {cachedBranding,cacheBranding,getBranding,GITHUB_URL,type Branding} from "./lib/settings";
import { NoteHistory } from "./components/NoteHistory";
import { NoteTitle } from "./components/NoteTitle";
import { HoverTooltip } from "./components/HoverTooltip";
import { FolderTree } from "./components/FolderTree";
import { readNavigation, saveNavigation } from "./lib/navigation";
import { isInFolder } from "./lib/folders";
import { NoteList } from "./components/NoteList";
import { MarkdownEditor } from "./components/MarkdownEditor";
import {
  createBackup, getBackupStatus, listBackups, restoreBackup, retryBackupJob,
  type BackupSnapshot, type BackupStatus
} from "./lib/backups";
import {
  addAttachment, createNote, db, purgeNote, recoverDraft, restoreNote, trashNote, updateNote, type Note, type NoteSummary, putLocalNote
} from "./lib/db";
import { startVisiblePolling } from "./lib/visible-polling";
import { useNotebookIndex } from "./lib/use-notebook-index";
import { resolveConflict, fromServer, startAutoSync, subscribeSync, syncNow, type SyncState } from "./lib/sync";

type View = "all" | "favorites" | "recent" | "trash";
const apiBase = import.meta.env.VITE_API_URL?.replace(/\/$/, "") || "/api";

const syncCopy: Record<SyncState, string> = {
  offline: "离线 · 已存本机", idle: "已同步", pending: "等待同步", syncing: "同步中…", conflict: "有冲突待处理", error: "同步暂不可用"
};

type SearchResult = {
  id: string;
  title: string;
  content?: string;
  excerpt?: string;
  tags: string[];
  folder: string;
  revision: number;
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

const EMPTY_NOTES:NoteSummary[]=[];
function fromSearchResult(note: SearchResult): NoteSummary {
  return {
    id: note.id,
    title: note.title,
    excerpt: note.excerpt ?? note.content?.slice(0,72) ?? "",
    indexToken: "remote:"+note.revision,
    parentId: note.folder || null,
    tags: note.tags,
    favorite: note.favorite,
    createdAt: Date.parse(note.createdAt),
    updatedAt: Date.parse(note.updatedAt),
    deletedAt: note.deletedAt ? Date.parse(note.deletedAt) : null,
    version: note.revision,
  };
}

function Login({ onLogin,branding }: { onLogin: (name: string, password: string) => Promise<void>;branding:Branding }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || password.length < 4) return;
    setBusy(true);
    setError("");
    try {
      await onLogin(name.trim(), password);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "登录失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="login">
      <BrandMark className="login-mark" branding={branding}/>
      <section className="login-sheet">
        <p className="eyebrow">QINGJI · PRIVATE DESK</p>
        <h1>{branding.name}</h1>
        <p className="login-lead">写下尚未成形的念头。笔记先留在本机，联网后再安静地同步。</p>
        <form onSubmit={submit}>
          <label>账号<input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="你的名字" /></label>
          <label>密码<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="至少 4 位" /></label>
          {error && <p className="login-error" role="alert">{error}</p>}
          <button type="submit" disabled={busy}>{busy ? "正在验证…" : "进入书桌"} <span>→</span></button>
        </form>
        <small>凭据只发送给你的私有服务，登录令牌保存在当前设备。</small>
      </section>
    </main>
  );
}

function InputDialog({ title, initialValue, onCancel, onConfirm }: {
  title: string;
  initialValue: string;
  onCancel: () => void;
  onConfirm: (value: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  return <div className="dialog-backdrop" role="presentation" onMouseDown={onCancel}>
    <form className="input-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" onSubmit={(event) => {
      event.preventDefault();
      onConfirm(value);
    }} onMouseDown={(event) => event.stopPropagation()}>
      <h2 id="dialog-title">{title}</h2>
      <input autoFocus value={value} onChange={(event) => setValue(event.target.value)} />
      <div className="dialog-actions"><button type="button" onClick={onCancel}>取消</button><button className="primary" type="submit">确定</button></div>
    </form>
  </div>;
}

function BackupPanel() {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [snapshots, setSnapshots] = useState<BackupSnapshot[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [restoreTarget, setRestoreTarget] = useState<BackupSnapshot | null>(null);

  const refresh = async () => {
    const next = await getBackupStatus();
    setStatus(next);
    setSnapshots(next.configured ? await listBackups() : []);
  };

  useEffect(() => {
    if (busy) return;
    let closed = false;
    let completed: string | undefined;
    const stop = startVisiblePolling(async () => {
      try {
        const next = await getBackupStatus();
        if (closed) return 60000;
        setStatus(next); setStatusError("");
        const signature = `${next.configured}:` + (next.jobs?.filter(job => job.state === "succeeded").map(job => job.id).join(",") ?? "");
        if (signature !== completed) {
          const list = next.configured ? await listBackups() : [];
          if (!closed) { setSnapshots(list); completed = signature; }
        }
        return next.running || next.jobs?.some(job => job.state === "queued" || job.state === "running") ? 3000 : 60000;
      } catch (reason) {
        if (!closed) setStatusError(reason instanceof Error ? reason.message : "无法读取备份状态");
        return 60000;
      }
    });
    return () => { closed = true; stop(); };
  }, [busy]);

  const backup = async () => {
    setBusy(true);
    setError("");
    try {
      await createBackup();
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "备份失败");
    } finally {
      setBusy(false);
    }
  };

  const restore = async (snapshot: BackupSnapshot, confirmation: string) => {
    if (confirmation !== snapshot.id) {
      setError("快照 ID 不匹配，恢复已取消");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await restoreBackup(snapshot.id);
      await refresh();
      setBusy(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "恢复失败");
      setBusy(false);
    }
  };

  const job = status?.jobs?.[0];
  const working = busy || job?.state === "queued" || job?.state === "running";
  const progress=job?.progress;
  const latest = snapshots[0] ?? status?.lastBackup;
  return <section className="context-section backup-panel">
    <h3><Cloud size={14} /> 云端备份</h3>
    {!status && !error && !statusError && <p className="muted">正在读取备份状态…</p>}
    {status && !status.configured && <p className="muted">S3 备份尚未启用或配置未完成。笔记保存在服务器，新增改动不会备份到 S3。</p>}
    {status?.configured && <>
      <p className="backup-status">
        {latest ? `最近备份：${new Date(latest.createdAt).toLocaleString("zh-CN")}` : "还没有云端快照"}
      </p>
      <button className="text-action backup-now" disabled={working || !!status.running || !!status.protection} onClick={() => void backup()}>
        <Cloud size={13} />{busy ? "处理中…" : "立即备份"}
      </button>
      {!!snapshots.length && <div className="snapshot-list">
        {snapshots.slice(0, 5).map((snapshot) => <div key={snapshot.id}>
          <span>{new Date(snapshot.createdAt).toLocaleString("zh-CN")}</span>
          <button disabled={working} onClick={() => setRestoreTarget(snapshot)} title={snapshot.id}>
            <RotateCcw size={12} />恢复
          </button>
        </div>)}
      </div>}
      <small>{status.scheduleEnabled ? `修改停止 ${status.automation?.debounceSeconds ?? 60} 秒后备份，最长等待 ${(status.automation?.maxWaitSeconds ?? 600)<60 ? `${status.automation?.maxWaitSeconds} 秒` : `${Math.ceil((status.automation?.maxWaitSeconds ?? 600)/60)} 分钟`}；每 ${status.intervalHours} 小时兜底检查` : "自动备份关闭"}；保留最近 {status.retention} 个普通快照，受保护快照另行保留</small>
      {status.automation?.enabled && !!status.automation.pendingChanges && <p className="backup-status">有变更等待备份{status.automation.nextRunAt ? `，预计 ${new Date(status.automation.nextRunAt).toLocaleTimeString("zh-CN")}` : ""}</p>}
      {status.automation?.blockedReason && <p className="backup-error">自动备份已暂停：{status.automation.blockedReason}。请检查后手动备份。</p>}
      {status.cleanupError && <p className="backup-error">备份已完成，旧快照清理未完成：{status.cleanupError}</p>}
      {job && <div className="backup-status" aria-live="polite">
        <p>{job.kind === "restore" ? "恢复" : "备份"}任务：{{queued:"排队中",running:"进行中",succeeded:"完成",failed:"失败，已保留现场"}[job.state]}</p>
        {progress && <p>{progress.completedFiles} / {progress.totalFiles} 个文件 · {(progress.completedBytes / 1e6).toFixed(1)} / {(progress.totalBytes / 1e6).toFixed(1)} MB</p>}
        {job.state === "running" && progress?.lastProgressAt && Date.now()-progress.lastProgressAt>60000 ? <p>超过一分钟没有新增完成文件，可能正在重试或处理大文件。</p> : null}
        {job.kind === "backup" && job.state === "succeeded" && job.metrics && <p>{job.metrics.skipped ? "内容无变化，已复用最近快照" : "已创建新快照"}；计算 {job.metrics.hashedFiles} 个文件哈希，上传 {job.metrics.uploadedFiles} 个文件（{(job.metrics.uploadedBytes / 1e6).toFixed(2)} MB）</p>}
        {job.telemetry && <p>耗时 {((job.durationMs??0)/1000).toFixed(1)} 秒 · S3 上传 {(job.telemetry.s3PutBytes/1e6).toFixed(2)} MB / 下载 {(job.telemetry.s3GetBytes/1e6).toFixed(2)} MB · {job.telemetry.s3Calls} 次调用</p>}
        {job.telemetry?.bottleneck && <p>主要耗时：{({capturing:"建立快照",scanning:"计算文件哈希",inventory:"核对远端对象",manifests:"读取快照清单",uploading:"上传内容",comparing:"比较快照",publishing:"发布快照",cleaning:"清理旧备份",releasing:"释放暂存文件",downloading:"下载恢复数据",switching:"切换数据"} as Record<string,string>)[job.telemetry.bottleneck.phase]??job.telemetry.bottleneck.phase}（{(job.telemetry.bottleneck.durationMs/1000).toFixed(1)} 秒）；写入锁定 {(job.telemetry.writeLockMs/1000).toFixed(1)} 秒</p>}
        {job.observabilityError && <p className="backup-error">备份观测记录写入失败，请检查服务器磁盘。</p>}
        {job.cleanupWarning && <p className="backup-error">清理尚未完成：{job.cleanupWarning}</p>}
        {job.error && <p>{job.error}</p>}
        {job.state === "failed" && <button onClick={()=>void retryBackupJob(job.id).then(refresh).catch(e=>setError(String(e)))}>重试并复用已完成文件</button>}
        {job.state === "succeeded" && job.kind === "restore" && <button onClick={()=>void syncNow()}>同步恢复后的笔记</button>}
      </div>}
    </>}
    {status?.protection && <p className="backup-error">恢复保护中：写入和备份已暂停。失败或重启不会解除保护。</p>}
    {statusError && <p className="backup-error">{statusError}</p>}
    {error && <p className="backup-error">{error}</p>}
    {restoreTarget && <InputDialog title="输入快照 ID 以确认恢复" initialValue="" onCancel={() => setRestoreTarget(null)} onConfirm={(value) => {
      const target = restoreTarget;
      setRestoreTarget(null);
      void restore(target, value);
    }} />}
  </section>;
}

function App() {
  const [branding,setBranding]=useState<Branding>(cachedBranding);
  const [settingsOpen,setSettingsOpen]=useState(false);
  const [settingsVersion,setSettingsVersion]=useState(0);
  const applyBranding=useCallback((value:Branding)=>{setBranding(value);cacheBranding(value);},[]);
  useEffect(()=>{
    let active=true;
    const refresh=()=>void getBranding().then(value=>{if(active)applyBranding(value);}).catch(()=>{});
    const stored=(event:StorageEvent)=>{if(event.key==='mynote:branding')setBranding(cachedBranding());};
    refresh();window.addEventListener('focus',refresh);window.addEventListener('storage',stored);
    return()=>{active=false;window.removeEventListener('focus',refresh);window.removeEventListener('storage',stored);};
  },[applyBranding]);
  useEffect(()=>{
    document.title=branding.name;
    const favicon=document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if(favicon){
      const text=branding.logoText.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
      favicon.href=branding.logoImage||'data:image/svg+xml,'+encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="8" fill="#ac3528"/><text x="32" y="42" text-anchor="middle" font-size="32" fill="white">${text}</text></svg>`);
    }
    const manifest=document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    if(manifest)manifest.href=apiBase+'/branding/manifest';
  },[branding]);
  const [user, setUser] = useState(() =>
    localStorage.getItem("mynote:token") ? localStorage.getItem("mynote:user") ?? "个人笔记" : ""
  );
  const [initialNavigation] = useState(()=>readNavigation(user));
  const [view, setView] = useState<View>(initialNavigation.view);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(initialNavigation.folder);
  const [selectedId, setSelectedId] = useState(initialNavigation.noteId);
  const [expandedFolders, setExpandedFolders] = useState(initialNavigation.expanded);
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState(true);
  const [mobileNav, setMobileNav] = useState(false);
  const [rightOpen, setRightOpen] = useState(true);
  const [leftWidth, setLeftWidth] = useState(260);
  const [rightWidth, setRightWidth] = useState(292);
  const [syncState, setSyncState] = useState<SyncState>("offline");
  const [syncDetail, setSyncDetail] = useState("");
  const [remoteSearch, setRemoteSearch] = useState<NoteSummary[] | null>(null);
  const [inputDialog, setInputDialog] = useState<{
    title: string;
    initialValue: string;
    onConfirm: (value: string) => void;
  } | null>(null);
  const [historyNote, setHistoryNote] = useState<Note | null>(null);
  const [dirty, setDirty] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftId, setDraftId] = useState("");
  const [title, setTitle] = useState("");
  const saveJobs = useRef(new Map<string, { timer: number; patch: { title?: string; content?: string } }>());
  const fileRef = useRef<HTMLInputElement>(null);
  const openingId=useRef<string|undefined>(undefined);

  useEffect(()=>{
    const guard=(event:BeforeUnloadEvent)=>{
      if(saveJobs.current.size){event.preventDefault();event.returnValue="";}
    };
    window.addEventListener("beforeunload",guard);
    return()=>window.removeEventListener("beforeunload",guard);
  },[]);

  useEffect(() => {
    if (!user) return;
    const token = localStorage.getItem("mynote:token");
    if (!token) {
      setUser("");
      return;
    }
    const controller = new AbortController();
    void fetch(`${apiBase}/auth/session`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    }).then((response) => {
      if (response.status !== 401 || controller.signal.aborted) return;
      localStorage.removeItem("mynote:user");
      localStorage.removeItem("mynote:token");
      setUser("");
    }).catch(() => {
      // The sync loop owns transient network errors; do not log the user out
      // merely because the session check was temporarily unreachable.
    });
    return () => controller.abort();
  }, [user]);

  useEffect(() => {
    const trimmed = query.trim();
    setRemoteSearch(null);
    if (!user || view === "trash" || !trimmed) {
      setRemoteSearch(null);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetch(`${apiBase}/search?q=${encodeURIComponent(trimmed)}&summary=1`, {
        headers: { authorization: `Bearer ${localStorage.getItem("mynote:token") ?? ""}` },
        signal: controller.signal,
      }).then(async (response) => {
        if (!response.ok) throw new Error("server search unavailable");
        const data = await response.json() as { results?: SearchResult[] };
        if (!controller.signal.aborted) setRemoteSearch((data.results ?? []).map(fromSearchResult));
      }).catch(() => {
        // Keep local Dexie search available when offline or when the API is unavailable.
      });
    }, 220);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, user, view]);

  const catalog = useLiveQuery(() => db.catalog.orderBy("updatedAt").reverse().toArray());
  const notes=catalog??EMPTY_NOTES;
  const loadedNote=useLiveQuery(()=>selectedId?db.notes.get(selectedId):undefined,[selectedId]);
  const recoveryDrafts = useLiveQuery(() => db.recoveryDrafts.toArray(), [], []);
  const conflicts = useLiveQuery(() => db.conflicts.toArray(), [], []);
  const pendingCount = useLiveQuery(() => db.outbox.count(), [], 0);
  const attachments = useLiveQuery(
    () => selectedId ? db.attachments.where("noteId").equals(selectedId).toArray() : [],
    [selectedId], []
  );
  const notesById = useMemo(() => new Map(notes.map(note => [note.id,note])),[notes]);
  const selected=loadedNote?.id===selectedId?loadedNote:undefined;
  const localIndex=useNotebookIndex(notes,query,selected?.title??"",!!user&&catalog!==undefined);
  const selectedPatch=saveJobs.current.get(selectedId)?.patch;
  const activeDraft=draftId===selectedId?draft:selectedPatch?.content??selected?.content??"";
  const activeTitle=draftId===selectedId?title:selectedPatch?.title??selected?.title??"";

  useEffect(() => {
    if (!user) return;
    const stopSync = startAutoSync();
    const unsubscribe = subscribeSync((next, detail) => {
      setSyncState(next);
      setSyncDetail(detail ?? "");
    });
    return () => { stopSync(); unsubscribe(); };
  }, [user]);

  useEffect(() => {
    if(catalog===undefined || (!notes.length && syncState!=="idle"))return;
    if(selectedId&&openingId.current===selectedId&&!notesById.has(selectedId))return;
    const folderExists=selectedFolder===null||notes.some(note=>!note.deletedAt&&isInFolder(note.parentId,selectedFolder));
    if(!folderExists){setSelectedFolder(null);return;}
    const eligible=(note:NoteSummary)=>{
      if(view==="trash"?!note.deletedAt:!!note.deletedAt)return false;
      if(view==="favorites"&&!note.favorite)return false;
      if(view==="recent"&&note.updatedAt<Date.now()-7*86400000)return false;
      return selectedFolder===null||isInFolder(note.parentId,selectedFolder);
    };
    const current=notesById.get(selectedId);
    if(current&&eligible(current)){openingId.current=undefined;return;}
    setSelectedId(notes.find(eligible)?.id??"");
  }, [catalog,notes,notesById,selectedId,selectedFolder,view,syncState]);

  useEffect(()=>{
    if(user&&catalog!==undefined&&notes.length)saveNavigation(user,{view,folder:selectedFolder,noteId:selectedId,expanded:expandedFolders});
  },[user,catalog,notes.length,view,selectedFolder,selectedId,expandedFolders]);

  useEffect(() => {
    setDraftId(selected?.id??"");
    const pending=selected?saveJobs.current.get(selected.id)?.patch:undefined;
    setDraft(pending?.content ?? selected?.content ?? "");
    setTitle(pending?.title ?? selected?.title ?? "");
  }, [selected?.id,selected?.version,selected?.content,selected?.title]);

  const shownNotes = useMemo(() => {
    const term=query.trim().toLocaleLowerCase();
    const localMatches=new Set(localIndex.matches);
    const remoteIds=new Set(remoteSearch?.map(note=>note.id));
    const source=[...notes,...(remoteSearch??[]).filter(note=>!notesById.has(note.id))];
    return source.filter(note=>{
      if(view==="trash"?!note.deletedAt:!!note.deletedAt)return false;
      if(view==="favorites"&&!note.favorite)return false;
      if(view==="recent"&&note.updatedAt<Date.now()-7*86400000)return false;
      if(selectedFolder!==null&&!isInFolder(note.parentId,selectedFolder))return false;
      if(!term)return true;
      return localMatches.has(note.id)||remoteIds.has(note.id)||`${note.title}\n${note.excerpt}\n${note.tags.join(" ")}\n${note.parentId??""}`.toLocaleLowerCase().includes(term);
    });
  },[notes,notesById,query,remoteSearch,localIndex.matches,view,selectedFolder]);
  const listHeading=view === "trash" ? "已删除" : query ? `搜索结果 · ${shownNotes.length}` : selectedFolder!==null ? `${selectedFolder||"未分类"} · ${shownNotes.length}` : "笔记";
  const backlinks=useMemo(()=>localIndex.backlinks.flatMap(id=>{
    const note=notesById.get(id);return note&&!note.deletedAt&&id!==selectedId?[note]:[];
  }),[localIndex.backlinks,notesById,selectedId]);

  const scheduleSave = (patch: { title?: string; content?: string }) => {
    if (!selectedId) return;
    setDirty(true);
    const noteId = selectedId;
    const previous = saveJobs.current.get(noteId);
    if (previous) window.clearTimeout(previous.timer);
    const combined = { ...previous?.patch, ...patch };
    const timer = window.setTimeout(async () => {
      const saving=saveJobs.current.get(noteId);
      try {
        await updateNote(noteId, combined);
        if(saveJobs.current.get(noteId)===saving)saveJobs.current.delete(noteId);
        setDirty(saveJobs.current.size>0);
      } catch (reason) {
        setSyncState("error");
        setSyncDetail(reason instanceof Error ? reason.message : "保存失败");
      }
    }, 450);
    saveJobs.current.set(noteId, { timer, patch: combined });
  };

  const openHistory = async () => {
    if (!selected) return;
    try {
      const job = saveJobs.current.get(selected.id);
      if (job) {
        window.clearTimeout(job.timer);saveJobs.current.delete(selected.id);
        await updateNote(selected.id,job.patch);setDirty(false);
      }
      await syncNow();
      if (await db.outbox.where("entityId").equals(selected.id).count()) throw new Error("这篇笔记还有未同步修改，请联网同步后查看历史。");
      const current = await db.notes.get(selected.id);
      if (current) setHistoryNote(current);
    } catch (reason) { setSyncState("error");setSyncDetail((reason as Error).message); }
  };

  const openWikiLink=useCallback((title:string)=>{
    const target=notes.find(note=>!note.deletedAt&&(note.title===title||note.id===title));
    if(target){setSelectedFolder(null);setView("all");setSelectedId(target.id);}
  },[notes]);

  const openNote = useCallback((note: NoteSummary) => {
    if(selectedFolder!==null&&!isInFolder(note.parentId,selectedFolder))setSelectedFolder(null);
    if((view==="favorites"&&!note.favorite)||(view==="recent"&&note.updatedAt<Date.now()-7*86400000)||(view==="trash"&&!note.deletedAt))setView("all");
    openingId.current=note.id;
    setSelectedId(note.id);setMobileNav(false);
    if(notesById.has(note.id))return;
    void (async()=>{
      const response=await fetch(`${apiBase}/notes/${encodeURIComponent(note.id)}`,{headers:{authorization:`Bearer ${localStorage.getItem("mynote:token")??""}`}});
      if(!response.ok)throw new Error(`正文读取失败（${response.status}）`);
      const body=fromServer((await response.json()).note);
      await db.transaction("rw",db.notes,db.catalog,async()=>{
        if(!await db.notes.get(body.id))await putLocalNote(body);
      });
    })().catch(error=>{setSyncState("error");setSyncDetail(error.message);});
  },[notesById,selectedFolder,view]);

  const addNote = async () => {
    const note = await createNote(selectedFolder);
    openingId.current=note.id;
    setView("all");
    setSelectedId(note.id);
  };

  const uploadAttachment = async (file: File) => {
    if (!selected) return;
    try {
      await syncNow();
      if(await db.outbox.where("entityId").equals(selected.id).count())throw new Error("笔记尚未同步到服务器，请联网同步后再上传附件。");
      const attachment = await addAttachment(selected.id, file);
      if (attachment.remotePath) {
        const escapedName = file.name.replaceAll("[", "\\[").replaceAll("]", "\\]");
        const link = file.type.startsWith("image/")
          ? `![${escapedName}](${attachment.remotePath})`
          : `[${escapedName}](${attachment.remotePath})`;
        const content = `${draft.replace(/\s*$/, "")}\n\n${link}\n`;
        setDraft(content);
        scheduleSave({ content });
      }
    } catch (reason) {
      setSyncState("error");
      setSyncDetail(reason instanceof Error ? reason.message : "附件上传失败");
    }
  };

  const displaySyncState: SyncState =
    syncState === "idle" && (dirty || pendingCount > 0) ? "pending" : syncState;
  const displaySyncLabel = dirty
    ? "编辑中…"
    : displaySyncState === "pending" && pendingCount
      ? `${pendingCount} 项等待同步`
      : syncCopy[displaySyncState];

  const resize = (side: "left" | "right") => (event: ReactPointerEvent) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const start = event.clientX;
    const initial = side === "left" ? leftWidth : rightWidth;
    const move = (pointer: globalThis.PointerEvent) => {
      const delta = pointer.clientX - start;
      side === "left"
        ? setLeftWidth(Math.min(390, Math.max(210, initial + delta)))
        : setRightWidth(Math.min(420, Math.max(240, initial - delta)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  if (!user) return <Login branding={branding} onLogin={async (name, password) => {
    const response = await fetch(`${apiBase}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password })
    });
    if (!response.ok) throw new Error(response.status === 401 ? "账号或密码不正确" : response.status===429?"登录尝试过于频繁，请一分钟后重试。": `服务不可用（${response.status}）`);
    const data = await response.json();
    localStorage.setItem("mynote:token", data.token);
    localStorage.setItem("mynote:user", name);
    const navigation=readNavigation(name);
    setView(navigation.view);setSelectedFolder(navigation.folder);setSelectedId(navigation.noteId);setExpandedFolders(navigation.expanded);
    setUser(name);
  }} />;

  return (
    <main data-index-reads={localIndex.reads} data-index-pending={localIndex.pending} data-catalog-count={notes.length} className={`desk ${mobileNav ? "mobile-nav" : ""}`} style={{ "--left": `${leftWidth}px`, "--right": `${rightOpen ? rightWidth : 0}px` } as React.CSSProperties}>
      <aside className="left-panel">
        <header className="brand">
          <BrandMark branding={branding}/><strong data-tooltip={branding.name}>{branding.name}</strong>
          <button className="icon-btn mobile-only" aria-label="关闭菜单" onClick={() => setMobileNav(false)}><X size={17} /></button>
        </header>
        <div className="search-box"><Search size={15} /><input value={query} onChange={(e) => { setQuery(e.target.value); if(e.target.value.trim())setSelectedFolder(null); }} placeholder="搜索全部笔记…" />{query && <button onClick={() => setQuery("")}><X size={13} /></button>}</div>
        <nav className="views">
          <button className={view === "all" && selectedFolder===null ? "active" : ""} onClick={() => { setView("all"); setSelectedFolder(null); }}><ChevronsUpDown />全部笔记 <span>{notes.filter(n => !n.deletedAt).length}</span></button>
          <button className={view === "favorites" ? "active" : ""} onClick={() => { setView("favorites"); setSelectedFolder(null); }}><Star />收藏</button>
          <button className={view === "recent" ? "active" : ""} onClick={() => { setView("recent"); setSelectedFolder(null); }}><Zap />最近</button>
          <button className={view === "trash" ? "active" : ""} onClick={() => { setView("trash"); setSelectedFolder(null); }}><Trash2 />回收站</button>
        </nav>
        <FolderTree notes={notes} selectedNoteId={selectedId} selected={selectedFolder} expanded={expandedFolders} onExpandedChange={setExpandedFolders} onOpenNote={(note,path)=>{
          setSelectedFolder(path);setView("all");setQuery("");
          openingId.current=note.id;setSelectedId(note.id);setMobileNav(false);
        }} onSelect={path=>{
          setSelectedFolder(path);setView("all");setQuery("");
          const first=notes.find(note=>!note.deletedAt&&isInFolder(note.parentId,path));
          if(first){openingId.current=first.id;setSelectedId(first.id);}
        }}/>
        <div className="tree-head"><span tabIndex={0} data-tooltip={listHeading}>{listHeading}</span><button className="icon-btn" onClick={addNote} title="新建笔记"><FilePlus2 size={16} /></button></div>
        {query&&localIndex.pending>0&&<p className="index-status" role="status">正在检索本地正文…</p>}
        {query&&localIndex.error&&<p className="index-status" role="status">{localIndex.error}</p>}
        <NoteList notes={shownNotes} selectedId={selectedId} query={query} resetKey={JSON.stringify([view,query,selectedFolder])} onOpen={openNote}/>
        <footer className="account">
          <div className="avatar">{user.slice(0, 1)}</div><span><b data-tooltip={user}>{user}</b><small data-tooltip-mode={syncDetail?'always':undefined} data-tooltip={syncDetail?`${displaySyncLabel}：${syncDetail}`:displaySyncLabel}>{displaySyncLabel}</small></span>
          <a className="icon-btn" href={GITHUB_URL} target="_blank" rel="noreferrer" aria-label="GitHub 项目" data-tooltip-mode="always" data-tooltip="GitHub 项目"><Github size={15}/></a>
          <button className="icon-btn" aria-label="设置" data-tooltip-mode="always" data-tooltip="设置" onClick={()=>setSettingsOpen(true)}><Settings size={16}/></button>
          <button className="icon-btn" title="退出" onClick={() => {
            const token = localStorage.getItem("mynote:token");
            void fetch(`${apiBase}/auth/logout`, {
              method: "POST",
              headers: token ? { authorization: `Bearer ${token}` } : {}
            });
            localStorage.removeItem("mynote:user");
            localStorage.removeItem("mynote:token");
            setUser("");
          }}><LogOut size={15} /></button>
        </footer>
      </aside>

      <div className="splitter left-splitter" onPointerDown={resize("left")} />

      <section className="workspace">
        {selected ? <>
          <header className="editor-bar">
            <button className="icon-btn mobile-only mobile-menu" aria-label="打开菜单" onClick={() => setMobileNav(true)}><Menu size={18} /></button>
            <div className={`sync-state ${displaySyncState}`} title={syncDetail}><i />{displaySyncLabel}</div>
            <div className="mode-switch"><button className={!preview ? "active" : ""} onClick={() => setPreview(false)}>源码</button><button className={preview ? "active" : ""} onClick={() => setPreview(true)}>预览</button></div>
            <button className="icon-btn" onClick={() => setRightOpen(!rightOpen)} title="上下文面板">{rightOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}</button>
          </header>
          <div key={`${selected.id}:${preview?'preview':'source'}`} className={`note-content ${preview?'preview-content':'source-content'}`} tabIndex={preview?0:undefined} aria-label={preview?'正文阅读区':undefined}>
          <div className="title-line">
            <NoteTitle value={activeTitle} onChange={(value) => { setTitle(value); scheduleSave({ title: value }); }} />
            <button className={`icon-btn ${selected.favorite ? "accent" : ""}`} onClick={() => void updateNote(selected.id, { favorite: !selected.favorite })} title="收藏"><Star size={18} fill={selected.favorite ? "currentColor" : "none"} /></button>
          </div>
          <div className="editor-area">
            {preview
              ? <MarkdownPreview content={activeDraft} onNavigate={openWikiLink}/>
              : <MarkdownEditor key={selected.id} value={activeDraft} onChange={(content) => { setDraft(content); scheduleSave({ content }); }} />}
          </div>
          </div>
          <footer className="status-bar"><span>{activeDraft.replace(/\s/g, "").length} 字</span><span>Markdown</span><span>本地自动保存</span></footer>
        </> : <div className="blank-editor"><button className="icon-btn mobile-only" aria-label="打开菜单" onClick={()=>setMobileNav(true)}><Menu size={18}/></button><div className="watermark">{branding.logoText}</div><p>{selectedId?"正在读取正文…":"选择一篇笔记，或开始新的书写。"}</p><button onClick={addNote}>新建笔记</button></div>}
      </section>

      {rightOpen && <div className="splitter right-splitter" onPointerDown={resize("right")} />}
      {rightOpen && <aside className="right-panel">
        <header><span>上下文</span><button className="icon-btn" onClick={() => setRightOpen(false)}><X size={15} /></button></header>
        {selected && <>
          <section className="context-section">
            <h3><Tags size={14} /> 标签</h3>
            <div className="tags">{selected.tags.map(tag => <button key={tag} onClick={() => void updateNote(selected.id, { tags: selected.tags.filter(t => t !== tag) })}>#{tag} ×</button>)}<button className="add-tag" onClick={() => setInputDialog({ title: "添加标签", initialValue: "", onConfirm: (tag) => {
              setInputDialog(null);
              if (tag.trim()) void updateNote(selected.id, { tags: [...new Set([...selected.tags, tag.trim()])] });
            } })}>＋ 添加</button></div>
          </section>
          <section className="context-section">
            <h3><Link2 size={14} /> 反向链接 <span>{backlinks.length}</span></h3>
            {backlinks.map(note => <button className="backlink" key={note.id} onClick={() => setSelectedId(note.id)}><b data-tooltip={note.title}>{note.title}</b><small data-tooltip={note.excerpt}>{note.excerpt}</small></button>)}
            {!backlinks.length && <p className="muted">还没有其他笔记链接到这里。</p>}
          </section>
          <section className="context-section">
            <h3><Paperclip size={14} /> 附件 <span>{attachments.length}</span></h3>
            <input ref={fileRef} type="file" hidden onChange={(e) => { const file = e.target.files?.[0]; if (file) void uploadAttachment(file); e.target.value = ""; }} />
            {attachments.map(file => <div className="attachment" key={file.id}><Paperclip size={13} /><span data-tooltip={file.name}>{file.name}</span></div>)}
            <button className="text-action" onClick={() => fileRef.current?.click()}>上传附件</button>
          </section>
          <section className="context-section actions">
            <h3>整理</h3>
            <button onClick={() => void openHistory()}><RotateCcw size={14} />历史版本</button>
            {!selected.deletedAt ? <>
              <button data-tooltip={selected.parentId ? `移动至：${selected.parentId}` : "移动至文件夹"} onClick={() => setInputDialog({ title: "移动至文件夹", initialValue: selected.parentId ?? "", onConfirm: (folder) => {
                setInputDialog(null);
                void updateNote(selected.id, { parentId: folder.trim() || null });
              } })}><FolderInput size={14} />{selected.parentId ? `移动至：${selected.parentId}` : "移动至文件夹"}</button>
              <button className="danger" onClick={() => void trashNote(selected.id)}><Trash2 size={14} />移入回收站</button>
            </> : <>
              <button onClick={() => void restoreNote(selected.id)}><ArchiveRestore size={14} />恢复笔记</button>
              <button className="danger" onClick={() => {
                if (!confirm(`永久删除“${selected.title}”？此操作不可恢复。`)) return;
                void purgeNote(selected.id)
                  .then(() => setSelectedId(""))
                  .catch((reason) => {
                    setSyncState("error");
                    setSyncDetail(reason instanceof Error ? reason.message : "永久删除失败");
                  });
              }}><Trash2 size={14} />永久删除</button>
            </>}
          </section>
          {!!conflicts.length && <section className="context-section conflict-box">
            <h3>同步冲突 · {conflicts.length}</h3>
            <p>服务端已保留两份内容。确认后可在笔记列表中人工整理。</p>
            {conflicts.map(conflict => <div className="conflict" key={conflict.id}><b>{conflict.remote.title}</b><div><button onClick={() => { setSelectedId(conflict.entityId); void resolveConflict(conflict.id!, "local"); }}>保留本地</button><button onClick={() => void resolveConflict(conflict.id!, "remote")}>采用服务端</button></div></div>)}
          </section>}
        </>}
        {!!recoveryDrafts.length && <section className="context-section conflict-box">
          <h3>保留的本地修改 · {recoveryDrafts.length}</h3>
          <p className="muted">服务器数据有变化，这些草稿没有被丢弃或自动覆盖到服务器。</p>
          {recoveryDrafts.map(draft => <div className="conflict" key={draft.id}>
            <b>{draft.note.title}</b><small>{draft.reason}</small>
            <details><summary>查看草稿</summary><pre style={{whiteSpace:"pre-wrap",maxHeight:200,overflow:"auto"}}>{draft.note.content}</pre></details>
            <button onClick={() => void recoverDraft(draft.id).then(note => { if (note) setSelectedId(note.id); })}>另存为新笔记</button>
          </div>)}
        </section>}
        <BackupPanel key={settingsVersion}/>
        <footer><button onClick={() => void syncNow()}><Zap size={13} /> 立即同步</button><small>更新于 {selected ? new Date(selected.updatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "—"}</small></footer>
      </aside>}
      {historyNote && <NoteHistory note={historyNote} onClose={() => setHistoryNote(null)} onRestored={async () => {
        await syncNow();
        const current = await db.notes.get(historyNote.id);
        if (current) { setDraft(current.content);setTitle(current.title); }
      }} />}
      {inputDialog && <InputDialog {...inputDialog} onCancel={() => setInputDialog(null)} />}
      {settingsOpen&&<SettingsPage onClose={()=>setSettingsOpen(false)} onSaved={value=>{applyBranding(value);setSettingsVersion(v=>v+1);}}/>}
      <HoverTooltip />
    </main>
  );
}

export default App;
