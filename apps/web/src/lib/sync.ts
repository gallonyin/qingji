import {t} from './i18n';
import { db, putLocalNote, putLocalNotes, deleteLocalNote, clearLocalNotes, type Note, type OutboxItem } from "./db";
import { createUuid } from "./uuid";

export type SyncState = "offline" | "idle" | "pending" | "syncing" | "conflict" | "error";
export type SyncListener = (state: SyncState, detail?: string) => void;
export type SyncTransport = {
  push(item: OutboxItem): Promise<{ ok: boolean; note?: Note; conflict?: Note; conflictCopy?: Note }>;
  state?(): Promise<{epoch: string}>;
  pull(cursor: string, until?: number): Promise<{ notes: Note[]; deletedIds?: string[]; cursor: string; hasMore?: boolean; until?: number; epoch?: string }>;
};

type ServerNote = {
  id: string;
  title: string;
  content: string;
  tags: string[];
  folder: string;
  revision: number;
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

const apiBase = import.meta.env.VITE_API_URL?.replace(/\/$/, "") || "/api";

async function authHeaders(): Promise<HeadersInit> {
  const token = localStorage.getItem("mynote:token");
  return {...(token ? { authorization: `Bearer ${token}` } : {}), "x-vault-epoch": (await db.meta.get("vaultEpoch"))?.value ?? ""};
}

export function fromServer(note: ServerNote): Note {
  return {
    id: note.id,
    title: note.title,
    content: note.content,
    parentId: note.folder || null,
    tags: note.tags,
    favorite: note.favorite,
    createdAt: Date.parse(note.createdAt),
    updatedAt: Date.parse(note.updatedAt),
    deletedAt: note.deletedAt ? Date.parse(note.deletedAt) : null,
    serverVersion: note.revision,
    version: note.revision
  };
}

const listeners = new Set<SyncListener>();
let state: SyncState = navigator.onLine ? "idle" : "offline";
let timer: number | undefined;
let activeSync: Promise<void> | undefined;

export function subscribeSync(listener: SyncListener) {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

function emit(next: SyncState, detail?: string) {
  state = next;
  listeners.forEach((listener) => listener(next, detail));
}

export const httpTransport: SyncTransport = {
  async state() {
    const r = await fetch(`${apiBase}/sync/state`,{headers:await authHeaders()});
    if (!r.ok) throw new Error(t("无法读取同步状态（{0}）", r.status));
    return r.json();
  },
  async push(item) {
    const response = await fetch(`${apiBase}/sync/push`, {
      method: "POST",
      headers: { "content-type": "application/json", ...await authHeaders() },
      body: JSON.stringify({
        changes: [{
          operationId: item.operationId,
          id: item.entityId,
          baseRevision: item.baseRevision ?? Math.max(0, item.payload.version - 1),
          title: item.payload.title,
          content: item.payload.content,
          tags: item.payload.tags,
          folder: item.payload.parentId ?? "",
          favorite: item.payload.favorite,
          deleted: item.operation === "delete",
          restored: item.operation === "restore"
        }]
      })
    });
    if (!response.ok) throw new Error(t("推送失败（{0}）", response.status));
    const result = (await response.json()).results?.[0];
    if (!result?.note) throw new Error(t("服务端未返回同步结果"));
    const note = fromServer(result.note);
    return result.conflict
      ? {
          ok: false,
          conflict: fromServer(result.remote ?? result.note),
          conflictCopy: result.remote ? note : undefined,
        }
      : { ok: true, note };
  },
  async pull(cursor, until) {
    const response = await fetch(`${apiBase}/sync/pull?since=${encodeURIComponent(cursor || "0")}${until === undefined ? "" : `&until=${until}`}`, {
      headers: await authHeaders()
    });
    if (!response.ok) throw new Error(t("拉取失败（{0}）", response.status));
    const data = await response.json();
    return {
      notes: (data.changes ?? []).flatMap((change: { note: ServerNote | null }) => change.note ? [fromServer(change.note)] : []),
      deletedIds: (data.changes ?? []).flatMap(
        (change: { note: ServerNote | null; noteId: string }) => change.note ? [] : [change.noteId]
      ),
      hasMore: data.hasMore, until: data.until, epoch: data.epoch,
      cursor: String(data.cursor ?? cursor ?? "0")
    };
  }
};

async function runSync(transport: SyncTransport) {
  if (!navigator.onLine) {
    emit("offline");
    return;
  }
  emit("syncing");
  try {
    if (transport.state) {
      const {epoch} = await transport.state();
      const localEpoch = (await db.meta.get("vaultEpoch"))?.value;
      if (localEpoch !== epoch) {
        await db.transaction("rw",[db.notes,db.catalog,db.outbox,db.conflicts,db.meta,db.recoveryDrafts], async () => {
          for (const item of await db.outbox.toArray()) {
            await db.recoveryDrafts.put({id:item.operationId,note:item.payload,reason:t("服务器数据版本已变化"),createdAt:Date.now()});
          }
          for (const conflict of await db.conflicts.toArray()) {
            await db.recoveryDrafts.put({id:`conflict-${conflict.id}`,note:conflict.local,reason:t("恢复前的冲突草稿"),createdAt:Date.now()});
          }
          await clearLocalNotes(); await db.outbox.clear(); await db.conflicts.clear();
          await db.meta.bulkPut([{key:"vaultEpoch",value:epoch},{key:"syncCursor",value:"0"}]);
        });
      }
    }
    const pending = await db.outbox.orderBy("createdAt").toArray();
    for (const item of pending) {
      const result = await transport.push(item);
      if (result.conflict) {
        await db.transaction("rw", db.notes, db.catalog, db.outbox, db.conflicts, async () => {
          if (result.conflictCopy) await putLocalNote(result.conflictCopy);
          await db.conflicts.add({
            entityId: item.entityId,
            local: item.payload,
            remote: result.conflict!,
            createdAt: Date.now()
          });
          if (item.id) await db.outbox.delete(item.id);
        });
        continue;
      }
      if (result.ok) {
        await db.transaction("rw",db.notes, db.catalog,db.outbox,async () => {
          const latest = await db.outbox.where("entityId").equals(item.entityId).first();
          if (latest && latest.operationId !== item.operationId) {
            if (result.note) {
              latest.baseRevision = result.note.version;
              await db.outbox.put(latest);
              const local = await db.notes.get(item.entityId);
              if (local) await putLocalNote({...local,serverVersion:result.note.version});
            }
          } else {
            if (result.note) await putLocalNote(result.note);
            if (item.id) await db.outbox.delete(item.id);
          }
        });
      }
    }

    let cursor = (await db.meta.get("syncCursor"))?.value ?? "";
    let until: number | undefined;
    while (true) {
    const pulled = await transport.pull(cursor, until);
    if (pulled.epoch && pulled.epoch !== (await db.meta.get("vaultEpoch"))?.value) throw new Error(t("服务器数据已恢复，请重新同步"));
    until = pulled.until ?? until;
    if (pulled.hasMore && pulled.cursor === cursor) throw new Error(t("同步游标未前进"));
    await db.transaction("rw", [db.notes, db.catalog, db.outbox, db.conflicts, db.attachments, db.meta, db.recoveryDrafts], async () => {
      const ids=pulled.notes.map(note=>note.id);
      const [locals,queued]=await Promise.all([db.notes.bulkGet(ids),db.outbox.where("entityId").anyOf(ids).toArray()]);
      const pendingIds=new Set(queued.map(item=>item.entityId));
      const accepted:Note[]=[];
      for(let index=0;index<pulled.notes.length;index++){
        const remote=pulled.notes[index],local=locals[index],hasPending=pendingIds.has(remote.id);
        if(local&&hasPending&&remote.version>local.version){
          await db.conflicts.add({entityId:remote.id,local,remote,createdAt:Date.now()});
        }else if(!local||(!hasPending&&remote.version>=local.version))accepted.push(remote);
      }
      if(accepted.length)await putLocalNotes(accepted);
      for (const id of pulled.deletedIds ?? []) {
        const pending = await db.outbox.where("entityId").equals(id).first();
        if (pending) await db.recoveryDrafts.put({id:pending.operationId,note:pending.payload,reason:t("远端已删除，保留未上传修改"),createdAt:Date.now()});
        await deleteLocalNote(id);
        await db.outbox.where("entityId").equals(id).delete();
        await db.conflicts.where("entityId").equals(id).delete();
        if (!pending) await db.attachments.where("noteId").equals(id).delete();
      }
      await db.meta.put({ key: "syncCursor", value: pulled.cursor });
    });
    cursor = pulled.cursor;
    if (!pulled.hasMore) break;
    }
    emit((await db.conflicts.count()) > 0 ? "conflict" : "idle");
  } catch (error) {
    emit("error", error instanceof Error ? error.message : t("同步失败"));
  }
}

export function syncNow(transport: SyncTransport = httpTransport): Promise<void> {
  if (activeSync) return activeSync;
  const run = () => runSync(transport);
  activeSync = (async () => { if (navigator.locks) await navigator.locks.request("mynote-sync",async () => { await run(); }); else await run(); })().finally(() => {
    activeSync = undefined;
  });
  return activeSync!;
}

export async function resolveConflict(id: number, choice: "local" | "remote") {
  const conflict = await db.conflicts.get(id);
  if (!conflict) return;
  if (conflict.remote.id !== conflict.entityId) {
    await db.conflicts.delete(id);
    emit((await db.conflicts.count()) ? "conflict" : "idle");
    return;
  }
  await db.transaction("rw", db.notes, db.catalog, db.outbox, db.conflicts, async () => {
    const selected = choice === "local"
      ? { ...conflict.local, version: Math.max(conflict.local.version, conflict.remote.version) + 1, updatedAt: Date.now() }
      : conflict.remote;
    await putLocalNote(selected);
    if (choice === "local") {
      await db.outbox.add({
        operationId: createUuid(),
        entityId: selected.id,
        operation: "upsert",
        payload: selected,
        createdAt: Date.now(),
        attempts: 0
      });
    } else {
      await db.outbox.where("entityId").equals(selected.id).delete();
    }
    await db.conflicts.delete(id);
  });
  emit((await db.conflicts.count()) ? "conflict" : "idle");
}

export function startAutoSync() {
  const run = () => void syncNow();
  const onOffline = () => emit("offline");
  let changeTimer: number | undefined;
  const onChange = () => {
    if (!navigator.onLine) {
      emit("offline");
      return;
    }
    emit("pending");
    window.clearTimeout(changeTimer);
    changeTimer = window.setTimeout(run, 650);
  };
  window.addEventListener("online", run);
  window.addEventListener("offline", onOffline);
  window.addEventListener("mynote:changed", onChange);
  timer = window.setInterval(run, 30000);
  run();
  return () => {
    window.clearInterval(timer);
    window.clearTimeout(changeTimer);
    window.removeEventListener("online", run);
    window.removeEventListener("offline", onOffline);
    window.removeEventListener("mynote:changed", onChange);
  };
}
