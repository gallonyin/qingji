import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile, open } from "node:fs/promises";
import path from "node:path";
import {parse as parseYaml, stringify as stringifyYaml} from "yaml";
import {z} from "zod";
import { MetadataDatabase } from "./database.js";

export interface Note {
  id: string;
  title: string;
  content: string;
  tags: string[];
  folder: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  favorite: boolean;
  deletedAt: string | null;
  extraFrontmatter?: Record<string, unknown>;
}

export type NoteInput = Partial<Pick<Note, "id" | "title" | "content" | "tags" | "folder" | "favorite">>;

function safeFolder(value = ""): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!normalized) return "";
  if (normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("INVALID_FOLDER");
  }
  return normalized;
}

function serialize(note: Note): string {
  return "---\n" + stringifyYaml({
    ...note.extraFrontmatter,
    bodyFormat: "verbatim-v1",
    id: note.id,
    title: note.title,
    tags: note.tags,
    folder: note.folder,
    revision: note.revision,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    favorite: note.favorite,
    deletedAt: note.deletedAt,
  }).trimEnd() + "\n---\n" + note.content;
}

export function deserialize(raw: string): Note {
  // Only plain YAML is supported: imported frontmatter can never execute code.
  const match=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if(!match)throw new Error("INVALID_NOTE_FRONTMATTER");
  const parsed=parseYaml(match[1],{maxAliasCount:100});
  const schema=z.object({
    id:z.string().uuid(),title:z.string().default("Untitled"),tags:z.array(z.string()).default([]),
    folder:z.string().default(""),revision:z.number().int().positive().default(1),
    createdAt:z.string().refine(value=>Number.isFinite(Date.parse(value))),
    updatedAt:z.string().refine(value=>Number.isFinite(Date.parse(value))),
    favorite:z.boolean().default(false),deletedAt:z.string().refine(value=>Number.isFinite(Date.parse(value))).nullable().default(null),
    bodyFormat:z.string().optional(),
  }).passthrough();
  const data=schema.parse(parsed);
  const {bodyFormat,id,title,tags,folder,revision,createdAt,updatedAt,favorite,deletedAt,...extraFrontmatter}=data;
  const body=raw.slice(match[0].length);
  return {id,title,tags,folder:safeFolder(folder),revision,createdAt,updatedAt,favorite,deletedAt,
    content:bodyFormat==="verbatim-v1"?body:body.replace(/^\n/, "").replace(/\n$/, ""),
    ...(Object.keys(extraFrontmatter).length?{extraFrontmatter}:{})};
}

export class NoteStore {
  readonly notesRoot: string;
  readonly attachmentsRoot: string;
  private notes = new Map<string, Note>();
  private operation?: {id:string;noteId:string;conflict:boolean;remote?:Note};

  constructor(readonly dataRoot: string, private readonly metadata: MetadataDatabase) {
    this.notesRoot = path.join(dataRoot, "notes");
    this.attachmentsRoot = path.join(dataRoot, "attachments");
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.notesRoot, { recursive: true }),
      mkdir(this.attachmentsRoot, { recursive: true }),
    ]);
    for (const intent of this.metadata.intents()) {
      if (intent.purge) await this.finishPurge(intent.note);
      else await this.finishPersist(intent.note, intent.oldFolder, intent.kind, intent.operation);
    }
    await this.scan(false);
    this.metadata.db.transaction(() => {
      for (const note of this.notes.values()) this.metadata.rememberCurrent(note.id,note.revision,JSON.stringify(note),note.updatedAt);
    })();
  }

  private filename(note: Pick<Note, "id" | "folder">): string {
    return path.join(this.notesRoot, safeFolder(note.folder), `${note.id}.md`);
  }

  private async persist(note: Note, oldFolder?: string, kind: "upsert" | "restore" | "delete" = "upsert"): Promise<void> {
    const operation=this.operation ? {id:this.operation.id,result:{id:this.operation.noteId,operationId:this.operation.id,note,conflict:this.operation.conflict,remote:this.operation.remote}} : undefined;
    this.metadata.intent(note.id, {note, oldFolder, kind, operation});
    await this.finishPersist(note, oldFolder, kind, operation);
  }

  private async finishPersist(note: Note, oldFolder: string | undefined, kind: "upsert" | "restore" | "delete", operation?: {id:string;result:unknown}) {
    const destination = this.filename(note);
    await mkdir(path.dirname(destination), {recursive:true});
    const temp = destination + ".pending";
    const file = await open(temp, "w");
    try { await file.writeFile(serialize(note)); await file.sync(); } finally { await file.close(); }
    await rename(temp,destination);
    if (oldFolder !== undefined && oldFolder !== note.folder) await rm(this.filename({id:note.id,folder:oldFolder}),{force:true});
    this.metadata.finishIntent(note.id,kind,note.revision,JSON.stringify(note),operation);
    this.notes.set(note.id,structuredClone(note));
  }

  history(id: string, before: number, limit: number) {
    if (!this.notes.has(id)) throw new Error("NOT_FOUND");
    const rows = this.metadata.history(id,before,limit+1);
    return { versions: rows.slice(0,limit).map(row => {
      const note: Note = row.snapshot.startsWith("{") ? JSON.parse(row.snapshot) : deserialize(row.snapshot);
      return {id:row.id,revision:row.revision,createdAt:row.createdAt,title:note.title,deleted:!!note.deletedAt};
    }), hasMore:rows.length>limit };
  }

  historyVersion(id: string, historyId: number): Note {
    if (!this.notes.has(id)) throw new Error("NOT_FOUND");
    const row = this.metadata.historyEntry(id,historyId);
    if (!row) throw new Error("NOT_FOUND");
    return row.snapshot.startsWith("{") ? JSON.parse(row.snapshot) : deserialize(row.snapshot);
  }

  async restoreVersion(id: string, historyId: number, expectedRevision: number): Promise<Note> {
    const current = this.notes.get(id);
    if (!current) throw new Error("NOT_FOUND");
    if (current.deletedAt) throw new Error("NOTE_IN_TRASH");
    if (current.revision !== expectedRevision) throw new Error("REVISION_CONFLICT");
    const old = this.historyVersion(id,historyId);
    // Keep identity and creation time; restore content as a new, auditable revision.
    return this.update(id,{title:old.title,content:old.content,tags:old.tags,folder:old.folder,favorite:old.favorite},expectedRevision);
  }

  async create(input: NoteInput, kind: "upsert" | "restore" | "delete" = "upsert", deletedAt: string | null = null): Promise<Note> {
    const now = new Date().toISOString();
    const note: Note = {
      id: input.id ?? randomUUID(),
      title: input.title?.trim() || "Untitled",
      content: input.content ?? "",
      tags: [...new Set(input.tags ?? [])],
      folder: safeFolder(input.folder),
      revision: 1,
      createdAt: now,
      updatedAt: now,
      favorite: input.favorite ?? false,
      deletedAt,
    };
    if (this.notes.has(note.id)) throw new Error("ID_EXISTS");
    await this.persist(note, undefined, kind);
    return note;
  }

  get(id: string): Note | undefined {
    const note = this.notes.get(id);
    return note ? structuredClone(note) : undefined;
  }

  list(view: "active" | "recent" | "favorites" | "trash" = "active"): Note[] {
    let notes = [...this.notes.values()];
    notes = view === "trash" ? notes.filter((note) => note.deletedAt) : notes.filter((note) => !note.deletedAt);
    if (view === "favorites") notes = notes.filter((note) => note.favorite);
    return notes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((note) => structuredClone(note));
  }

  async update(id: string, patch: NoteInput, expectedRevision: number, kind: "upsert" | "restore" | "delete" = "upsert", deletedAt?: string | null): Promise<Note> {
    const current = this.notes.get(id);
    if (!current) throw new Error("NOT_FOUND");
    if (current.revision !== expectedRevision) throw new Error("REVISION_CONFLICT");
    const next: Note = {
      ...current,
      ...(patch.content===undefined?{}:{content:patch.content}),
      ...(patch.favorite===undefined?{}:{favorite:patch.favorite}),
      id: current.id,
      title: patch.title?.trim() || current.title,
      tags: patch.tags ? [...new Set(patch.tags)] : current.tags,
      folder: patch.folder === undefined ? current.folder : safeFolder(patch.folder),
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
      deletedAt: deletedAt===undefined?current.deletedAt:deletedAt,
    };
    await this.persist(next, current.folder,kind);

    return next;
  }

  async softDelete(id: string, expectedRevision: number): Promise<Note> {
    return this.update(id,{},expectedRevision,"delete",new Date().toISOString());
  }

  async restore(id: string, expectedRevision: number): Promise<Note> {
    return this.update(id,{},expectedRevision,"restore",null);
  }

  async purge(id: string, expectedRevision: number): Promise<void> {
    const current = this.notes.get(id);
    if (!current) throw new Error("NOT_FOUND");
    if (current.revision !== expectedRevision) throw new Error("REVISION_CONFLICT");
    if (!current.deletedAt) throw new Error("PURGE_REQUIRES_TRASH");

    this.metadata.intent(id,{note:current,purge:true});
    await this.finishPurge(current);
  }

  private async finishPurge(current: Note) {
    await rm(this.filename(current),{force:true});
    await rm(path.join(this.attachmentsRoot,current.id),{recursive:true,force:true});
    this.metadata.finishIntent(current.id,"purge",current.revision+1,"");
    this.notes.delete(current.id);
  }

  async applyPush(input: NoteInput & { id: string; baseRevision: number; operationId?: string; deleted?: boolean; restored?: boolean }): Promise<{ note: Note; conflict: boolean; remote?: Note }> {
    this.operation=input.operationId ? {id:input.operationId,noteId:input.id,conflict:false} : undefined;
    try {
    const current = this.notes.get(input.id);
    const equivalent = current && ["title","content","folder","favorite","tags"].every(key => {
      const value = input[key as keyof NoteInput];
      return value === undefined || JSON.stringify(value) === JSON.stringify(current[key as keyof Note]);
    }) && (input.deleted ? !!current.deletedAt : !current.deletedAt);
    if (equivalent && current.revision !== input.baseRevision) return {note:structuredClone(current),conflict:false};
    if (!current && input.baseRevision === 0) return { note: await this.create(input,input.deleted?"delete":"upsert",input.deleted?new Date().toISOString():null), conflict: false };
    if (!current || current.revision !== input.baseRevision) {
      if(this.operation){this.operation.conflict=true;this.operation.remote=current;}
      const hash = createHash("sha256").update(input.operationId ?? randomUUID()).digest("hex");
      const conflictId = `${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
      const conflict = this.get(conflictId) ?? await this.create({
        ...input,
        id: conflictId,
        title: `${input.title || current?.title || "Untitled"} (conflict ${new Date().toISOString()})`,
        folder: input.folder ?? current?.folder,
      });
      return { note: conflict, conflict: true, remote: current };
    }
    const note = input.deleted
      ? await this.update(input.id,input,input.baseRevision,"delete",new Date().toISOString())
      : input.restored
        ? await this.update(input.id,input,input.baseRevision,"restore",null)
        : await this.update(input.id, input, input.baseRevision);
    return { note, conflict: false };
    } finally {this.operation=undefined;}
  }

  search(query: string): Array<Note & { highlights: string[] }> {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return [];
    return this.list("active").flatMap((note) => {
      const fields = [note.title, note.content, note.tags.join(" "), note.folder];
      if (!fields.some((field) => field.toLocaleLowerCase().includes(needle))) return [];
      const highlights = fields.flatMap((field) => {
        const lower = field.toLocaleLowerCase();
        const index = lower.indexOf(needle);
        if (index < 0) return [];
        const start = Math.max(0, index - 24);
        const end = Math.min(field.length, index + query.length + 24);
        return [`${start > 0 ? "…" : ""}${field.slice(start, index)}<mark>${field.slice(index, index + query.length)}</mark>${field.slice(index + query.length, end)}${end < field.length ? "…" : ""}`];
      });
      return [{ ...note, highlights }];
    });
  }

  backlinks(id: string): Note[] {
    const target = this.notes.get(id);
    if (!target) throw new Error("NOT_FOUND");
    const tokens = [`[[${id}]]`, `[[${target.title}]]`];
    return this.list("active").filter((note) => note.id !== id && tokens.some((token) => note.content.includes(token)));
  }

  async saveAttachment(noteId: string, filename: string, data: Buffer): Promise<{ name: string; path: string; size: number }> {
    if (!this.notes.has(noteId)) throw new Error("NOT_FOUND");
    const name = path.basename(filename).replace(/[^\p{L}\p{N}._ -]/gu, "_") || randomUUID();
    const directory = path.join(this.attachmentsRoot, noteId);
    await mkdir(directory, { recursive: true });
    const destination = path.join(directory, name);
    // Persist the signal before replacing the attachment; a crash cannot lose the trigger.
    this.metadata.markBackupChange();
    const temporary = path.join(path.dirname(this.attachmentsRoot), `.attachment-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, data);
      await rename(temporary, destination);
    } finally { await rm(temporary, { force: true }); }
    return { name, path: `/api/attachments/${noteId}/${encodeURIComponent(name)}`, size: data.length };
  }

  async readAttachment(noteId: string, filename: string): Promise<Buffer> {
    if (!this.notes.has(noteId)) throw new Error("NOT_FOUND");
    const safeName = path.basename(filename);
    if (!safeName || safeName !== filename) throw new Error("NOT_FOUND");
    try {
      return await readFile(path.join(this.attachmentsRoot, noteId, safeName));
    } catch {
      throw new Error("NOT_FOUND");
    }
  }

  async scan(rebuild = true): Promise<{ scanned: number; errors: Array<{ file: string; error: string }> }> {
    const found = new Map<string, Note>();
    const errors: Array<{ file: string; error: string }> = [];
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(filename);
        else if (entry.isFile() && entry.name.endsWith(".md")) {
          try {
            const note = deserialize(await readFile(filename, "utf8"));
            note.folder = safeFolder(path.relative(this.notesRoot, path.dirname(filename)));
            if (!note.id || found.has(note.id)) throw new Error("missing or duplicate id");
            found.set(note.id, note);
          } catch (error) {
            errors.push({ file: filename, error: error instanceof Error ? error.message : String(error) });
          }
        }
      }
    };
    await visit(this.notesRoot);
    if (errors.length) throw new Error("INVALID_VAULT_FILES");
    if (rebuild) {
      this.metadata.db.transaction(() => {
        this.metadata.resetDerivedData();
        for (const note of found.values()) {
          this.metadata.record(note.id, note.deletedAt ? "delete" : "upsert", note.revision, JSON.stringify(note));
        }
      })();
    }
    this.notes = found;
    return { scanned: found.size, errors };
  }
}
