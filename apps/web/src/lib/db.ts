import Dexie, { type EntityTable } from "dexie";
import { createUuid } from "./uuid";

const apiBase = import.meta.env.VITE_API_URL?.replace(/\/$/, "") || "/api";

export type Note = {
  id: string;
  title: string;
  content: string;
  parentId: string | null;
  tags: string[];
  favorite: boolean;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  version: number;
  serverVersion?: number;
};

export type NoteSummary = Omit<Note,"content"> & {excerpt:string; indexToken:string};
export function summarizeNote(note:Note):NoteSummary {
  const {content,...metadata}=note;
  return {...metadata,excerpt:content.slice(0,72).replace(/[#*`>\n]/g," "),indexToken:createUuid()};
}

export type OutboxItem = {
  id?: number;
  operationId: string;
  baseRevision?: number;
  entityId: string;
  operation: "upsert" | "delete" | "restore";
  payload: Note;
  createdAt: number;
  attempts: number;
};

export type Conflict = {
  id?: number;
  entityId: string;
  local: Note;
  remote: Note;
  createdAt: number;
};

export type Attachment = {
  id: string;
  noteId: string;
  name: string;
  type: string;
  blob: Blob;
  remotePath?: string;
  createdAt: number;
};

export class MyNoteDB extends Dexie {
  catalog!: EntityTable<NoteSummary,"id">;
  noteIndex!: EntityTable<{id:string;indexToken:string;links:string[]},"id">;
  notes!: EntityTable<Note, "id">;
  outbox!: EntityTable<OutboxItem, "id">;
  conflicts!: EntityTable<Conflict, "id">;
  attachments!: EntityTable<Attachment, "id">;
  recoveryDrafts!: EntityTable<{ id: string; note: Note; reason: string; createdAt: number }, "id">;
  meta!: EntityTable<{ key: string; value: string }, "key">;

  constructor(name="mynote") {
    super(name);
    this.version(1).stores({
      notes: "id, parentId, updatedAt, deletedAt, favorite, *tags",
      outbox: "++id, entityId, createdAt",
      conflicts: "++id, entityId, createdAt",
      attachments: "id, noteId, createdAt",
      meta: "key"
    });
    this.version(2).stores({
      notes: "id, parentId, updatedAt, deletedAt, favorite, *tags",
      outbox: "++id, &operationId, entityId, createdAt",
      conflicts: "++id, entityId, createdAt",
      attachments: "id, noteId, createdAt",
      meta: "key"
    }).upgrade(async (transaction) => {
      await transaction.table<OutboxItem>("outbox").toCollection().modify((item) => {
        item.operationId = createUuid();
      });
    });
    this.version(3).stores({
      notes: "id, parentId, updatedAt, deletedAt, favorite, *tags",
      outbox: "++id, &operationId, entityId, createdAt",
      conflicts: "++id, entityId, createdAt",
      attachments: "id, noteId, createdAt",
      meta: "key",
      recoveryDrafts: "id, createdAt"
    });
    this.version(4).stores({catalog:"id, parentId, updatedAt, deletedAt, favorite, *tags",noteIndex:"id"}).upgrade(async transaction=>{
      let after:string|undefined;
      while(true){
        const table=transaction.table<Note>("notes");
        const batch=await (after===undefined?table.orderBy("id"):table.where("id").above(after)).limit(100).toArray();
        if(!batch.length)break;
        await transaction.table("catalog").bulkPut(batch.map(summarizeNote));
        after=batch.at(-1)!.id;
      }
    });
  }
}

export const db = new MyNoteDB();

const starter = `# 从这里开始

这里是一方安静的书写空间。所有改动会先保存到本机，再等待网络同步。

## 可以试试

- 用 \`[[晨间摘录]]\` 链接另一篇笔记
- 添加标签、收藏，或从右侧查看反向链接
- 切换到预览，检查排版

> 好的笔记，不必一次写完。`;

export async function seedDatabase() {
  await db.transaction("rw", db.notes, db.catalog, async () => {
    if (await db.notes.count()) return;
    const now = Date.now();
    const notes: Note[] = [
      { id: createUuid(), title: "从这里开始", content: starter, parentId: null, tags: ["指南"], favorite: true, createdAt: now, updatedAt: now, deletedAt: null, version: 1 },
      { id: createUuid(), title: "晨间摘录", content: "# 晨间摘录\n\n清晨适合记录还没有被解释的想法。", parentId: null, tags: ["随笔"], favorite: false, createdAt: now - 3600000, updatedAt: now - 3600000, deletedAt: null, version: 1 }
    ];
    await putLocalNotes(notes);
  });
}

async function enqueue(note: Note, operation: OutboxItem["operation"] = "upsert") {
  // Keep one pending mutation per note. A fast typing session can produce many
  // local revisions; only the newest snapshot is useful once it reaches sync.
  const pending = await db.outbox.where("entityId").equals(note.id).first();
  const baseRevision = pending?.baseRevision ?? note.serverVersion ?? Math.max(0, note.version - 1);
  await db.outbox.where("entityId").equals(note.id).delete();
  await db.outbox.add({
    operationId: createUuid(),
    baseRevision,
    entityId: note.id,
    operation,
    payload: note,
    createdAt: Date.now(),
    attempts: 0
  });
  if (typeof window !== "undefined") window.dispatchEvent(new Event("mynote:changed"));
}

export async function createNote(parentId: string | null = null) {
  const now = Date.now();
  const note: Note = { id: createUuid(), title: "未命名", content: "", parentId, tags: [], favorite: false, createdAt: now, updatedAt: now, deletedAt: null, version: 1 };
  await db.transaction("rw", db.notes, db.catalog, db.outbox, async () => {
    await putLocalNote(note);
    await enqueue(note);
  });
  return note;
}

export async function updateNote(id: string, patch: Partial<Pick<Note, "title" | "content" | "parentId" | "tags" | "favorite">>) {
  return db.transaction("rw", db.notes, db.catalog, db.outbox, async () => {
    const current = await db.notes.get(id);
    if (!current) throw new Error("笔记不存在");
    const note = { ...current, ...patch, updatedAt: Date.now(), version: current.version + 1 };
    await putLocalNote(note);
    await enqueue(note);
    return note;
  });
}

export async function trashNote(id: string) {
  await db.transaction("rw", db.notes, db.catalog, db.outbox, async () => {
    const current = await db.notes.get(id);
    if (!current) return;
    const note = { ...current, deletedAt: Date.now(), updatedAt: Date.now(), version: current.version + 1 };
    await putLocalNote(note);
    await enqueue(note, "delete");
  });
}

export async function restoreNote(id: string) {
  await db.transaction("rw", db.notes, db.catalog, db.outbox, async () => {
    const current = await db.notes.get(id);
    if (!current) return;
    const note = { ...current, deletedAt: null, updatedAt: Date.now(), version: current.version + 1 };
    await putLocalNote(note);
    await enqueue(note, "restore");
  });
}

export async function purgeNote(id: string) {
  const current = await db.notes.get(id);
  if (!current?.deletedAt) throw new Error("只有回收站中的笔记可以永久删除");
  if (!navigator.onLine) throw new Error("永久删除需要连接服务器");
  const token = localStorage.getItem("mynote:token");
  if (!token) throw new Error("登录已失效");

  const response = await fetch(`${apiBase}/notes/${id}/permanent?revision=${current.version}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}`, "x-vault-epoch": (await db.meta.get("vaultEpoch"))?.value ?? "" }
  });
  if (!response.ok) throw new Error(`永久删除失败（${response.status}）`);

  await db.transaction(
    "rw",
    db.notes, db.catalog,
    db.outbox,
    db.conflicts,
    db.attachments,
    async () => {
      await deleteLocalNote(id);
      await db.outbox.where("entityId").equals(id).delete();
      await db.conflicts.where("entityId").equals(id).delete();
      await db.attachments.where("noteId").equals(id).delete();
    }
  );
}

export async function addAttachment(noteId: string, file: File) {
  if(!navigator.onLine)throw new Error("附件上传需要联网；离线时可以继续编辑笔记正文。");
  const token = localStorage.getItem("mynote:token");
  let remotePath: string | undefined;
  if (token && navigator.onLine) {
    const body = new FormData();
    body.append("file", file);
    const response = await fetch(`${apiBase}/notes/${noteId}/attachments`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "x-vault-epoch": (await db.meta.get("vaultEpoch"))?.value ?? "" },
      body
    });
    if (!response.ok) throw new Error(`附件上传失败（${response.status}）`);
    remotePath = (await response.json()).attachment?.path;
  }
  const attachment: Attachment = {
    id: createUuid(),
    noteId,
    name: file.name,
    type: file.type,
    blob: file,
    remotePath,
    createdAt: Date.now()
  };
  await db.attachments.add(attachment);
  return attachment;
}

export async function recoverDraft(id: string) {
  return db.transaction("rw", db.notes, db.catalog, db.outbox, db.recoveryDrafts, db.attachments, async () => {
    const draft = await db.recoveryDrafts.get(id);
    if (!draft) return;
    const note: Note = {...draft.note,id:createUuid(),title:draft.note.title + "（保留的本地修改）",deletedAt:null,version:1,serverVersion:0,updatedAt:Date.now()};
    await putLocalNote(note);
    for (const attachment of await db.attachments.where("noteId").equals(draft.note.id).toArray()) {
      await db.attachments.put({...attachment, id:createUuid(), noteId:note.id});
    }
    await enqueue(note);
    await db.recoveryDrafts.delete(id);
    return note;
  });
}

/** All production note writes keep the lightweight catalog in the same transaction. */
export async function putLocalNotes(notes:Note[]) {
  await db.transaction("rw",db.notes,db.catalog,async()=>{
    await db.notes.bulkPut(notes);
    await db.catalog.bulkPut(notes.map(summarizeNote));
  });
}
export async function putLocalNote(note:Note){await putLocalNotes([note]);}
export async function deleteLocalNote(id:string){
  await db.transaction("rw",db.notes,db.catalog,async()=>{await db.notes.delete(id);await db.catalog.delete(id);});
}
export async function clearLocalNotes(){
  await db.transaction("rw",db.notes,db.catalog,async()=>{await db.notes.clear();await db.catalog.clear();});
}
