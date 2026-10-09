import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

export interface HistoryRow { id:number; revision:number; createdAt:string; epoch:string; snapshot:string; }

export interface SyncEvent {
  sequence: number;
  noteId: string;
  kind: "upsert" | "delete" | "restore" | "purge";
  revision: number;
  occurredAt: string;
}

export class MetadataDatabase {
  readonly db: Database.Database;

  constructor(filename: string) {
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS backup_changes (sequence INTEGER PRIMARY KEY AUTOINCREMENT, changed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS backup_schedule (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS vault_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pending_operations (operation_id TEXT PRIMARY KEY, request_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS file_intents (note_id TEXT PRIMARY KEY, intent_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS note_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        note_id TEXT NOT NULL,
        source_epoch TEXT NOT NULL,
        revision INTEGER NOT NULL,
        snapshot TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(note_id, source_epoch, revision)
      );
      CREATE INDEX IF NOT EXISTS note_history_page ON note_history(note_id, id);
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS revisions (
        note_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        snapshot TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (note_id, revision)
      );
      CREATE TABLE IF NOT EXISTS sync_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        note_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        revision INTEGER NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS processed_operations (
        operation_id TEXT PRIMARY KEY,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sync_events_note_id ON sync_events(note_id);
    `);
    this.db.transaction(() => {
      if(this.db.prepare("INSERT OR IGNORE INTO backup_schedule VALUES ('initialized','1')").run().changes)this.markBackupChange();
      if (!this.db.prepare("SELECT 1 FROM vault_state WHERE key='history_migrated'").get()) {
        this.db.prepare(`INSERT OR IGNORE INTO note_history(note_id,source_epoch,revision,snapshot,created_at)
          SELECT note_id,?,revision,snapshot,created_at FROM revisions WHERE snapshot <> '' ORDER BY created_at,revision`).run(this.epoch());
        this.db.prepare("INSERT INTO vault_state VALUES ('history_migrated','1')").run();
      }
    })();
  }

  epoch(): string {
    this.db.prepare("INSERT OR IGNORE INTO vault_state(key,value) VALUES ('epoch',?)").run(randomUUID());
    return (this.db.prepare("SELECT value FROM vault_state WHERE key='epoch'").get() as {value:string}).value;
  }

  beginOperation(id: string, request: unknown): void {
    const json = JSON.stringify(request);
    const old = this.db.prepare("SELECT request_json AS json FROM pending_operations WHERE operation_id=?").get(id) as {json:string} | undefined;
    if (old && old.json !== json) throw new Error("OPERATION_REUSED");
    this.db.prepare("INSERT OR IGNORE INTO pending_operations VALUES (?,?)").run(id,json);
  }

  abandonOperation(id: string) { this.db.prepare("DELETE FROM pending_operations WHERE operation_id=?").run(id); }

  pendingOperations(): any[] {
    return (this.db.prepare("SELECT request_json AS json FROM pending_operations WHERE operation_id NOT IN (SELECT operation_id FROM processed_operations)").all() as {json:string}[]).map(r=>JSON.parse(r.json));
  }

  intent(id: string, value: unknown) { this.db.prepare("INSERT OR REPLACE INTO file_intents VALUES (?,?)").run(id,JSON.stringify(value)); }
  intents(): any[] { return (this.db.prepare("SELECT intent_json AS json FROM file_intents").all() as {json:string}[]).map(r=>JSON.parse(r.json)); }
  finishIntent(id: string, kind: SyncEvent["kind"], revision: number, snapshot: string, operation?: {id:string;result:unknown}) {
    this.db.transaction(() => { this.record(id,kind,revision,snapshot); if(operation)this.saveOperation(operation.id,operation.result); this.db.prepare("DELETE FROM file_intents WHERE note_id=?").run(id); })();
  }

  createSession(tokenHash: string, expiresAt: string): void {
    this.db.prepare("INSERT OR REPLACE INTO sessions(token_hash, expires_at) VALUES (?, ?)").run(tokenHash, expiresAt);
  }

  hasSession(tokenHash: string, now: string): boolean {
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
    return Boolean(this.db.prepare("SELECT 1 FROM sessions WHERE token_hash = ?").get(tokenHash));
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
  }

  record(noteId: string, kind: SyncEvent["kind"], revision: number, snapshot: string): number {
    const occurredAt = new Date().toISOString();
    return this.db.transaction(() => {
      this.markBackupChange();
      this.db.prepare(
        "INSERT OR REPLACE INTO revisions(note_id, revision, snapshot, created_at) VALUES (?, ?, ?, ?)",
      ).run(noteId, revision, snapshot, occurredAt);
      if (snapshot) this.remember(noteId, revision, snapshot, occurredAt);
      if (kind === "purge") {
        this.db.prepare("DELETE FROM note_history WHERE note_id=?").run(noteId);
        this.db.prepare("DELETE FROM revisions WHERE note_id=?").run(noteId);
      }
      return Number(
        this.db.prepare(
          "INSERT INTO sync_events(note_id, kind, revision, occurred_at) VALUES (?, ?, ?, ?)",
        ).run(noteId, kind, revision, occurredAt).lastInsertRowid,
      );
    })();
  }

  pull(since: number, limit: number, until = this.latestSequence()): { events: SyncEvent[]; cursor: number; hasMore: boolean } {
    const rows = this.db.prepare(
      `SELECT sequence, note_id AS noteId, kind, revision, occurred_at AS occurredAt
       FROM sync_events WHERE sequence > ? AND sequence <= ? ORDER BY sequence LIMIT ?`,
    ).all(since, until, limit + 1) as SyncEvent[];
    const hasMore = rows.length > limit;
    const events = hasMore ? rows.slice(0, limit) : rows;
    return { events, cursor: events.at(-1)?.sequence ?? since, hasMore };
  }

  revisionSnapshot(id: string, revision: number): string | undefined {
    return (this.db.prepare("SELECT snapshot FROM revisions WHERE note_id=? AND revision=?").get(id,revision) as {snapshot:string} | undefined)?.snapshot;
  }

  remember(noteId: string, revision: number, snapshot: string, createdAt: string): void {
    this.db.prepare(`INSERT OR IGNORE INTO note_history(note_id,source_epoch,revision,snapshot,created_at) VALUES (?,?,?,?,?)`)
      .run(noteId,this.epoch(),revision,snapshot,createdAt);
  }

  // Upgrade the current legacy snapshot from the authoritative file without changing its date.
  rememberCurrent(noteId: string, revision: number, snapshot: string, createdAt: string): void {
    this.remember(noteId,revision,snapshot,createdAt);
    this.db.prepare("UPDATE note_history SET snapshot=? WHERE note_id=? AND source_epoch=? AND revision=?")
      .run(snapshot,noteId,this.epoch(),revision);
  }

  history(noteId: string, before: number, limit: number) {
    return this.db.prepare(`SELECT id,revision,created_at AS createdAt,source_epoch AS epoch,snapshot
      FROM note_history WHERE note_id=? AND id<? ORDER BY id DESC LIMIT ?`).all(noteId,before,limit) as HistoryRow[];
  }

  historyEntry(noteId: string, id: number) {
    return this.db.prepare(`SELECT id,revision,created_at AS createdAt,source_epoch AS epoch,snapshot
      FROM note_history WHERE note_id=? AND id=?`).get(noteId,id) as HistoryRow | undefined;
  }

  latestSequence(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(sequence), 0) AS value FROM sync_events").get() as { value: number };
    return row.value;
  }

  getOperation<T>(operationId: string): T | undefined {
    const row = this.db.prepare(
      "SELECT result_json AS resultJson FROM processed_operations WHERE operation_id = ?",
    ).get(operationId) as { resultJson: string } | undefined;
    return row ? JSON.parse(row.resultJson) as T : undefined;
  }

  saveOperation(operationId: string, result: unknown): void {
    this.db.prepare(
      "INSERT OR IGNORE INTO processed_operations(operation_id, result_json, created_at) VALUES (?, ?, ?)",
    ).run(operationId, JSON.stringify(result), new Date().toISOString());
  }

  resetDerivedData(): void {
    this.db.transaction(() => {
      this.db.prepare("INSERT OR REPLACE INTO vault_state VALUES ('epoch',?)").run(randomUUID());
      this.db.prepare("DELETE FROM processed_operations").run();
      this.db.prepare("DELETE FROM pending_operations").run();
      this.db.prepare("DELETE FROM revisions").run();
      this.db.prepare("DELETE FROM sync_events").run();
    })();
  }

  markBackupChange() {
    this.db.prepare("INSERT INTO backup_changes(changed_at) VALUES (?)").run(Date.now());
  }

  backupScheduleState() {
    const pending=this.db.prepare("SELECT COUNT(*) AS count, COALESCE(MAX(sequence),0) AS revision, MIN(changed_at) AS firstAt, MAX(changed_at) AS lastAt FROM backup_changes").get() as {count:number;revision:number;firstAt:number|null;lastAt:number|null};
    const settings=Object.fromEntries((this.db.prepare("SELECT key,value FROM backup_schedule").all() as {key:string;value:string}[]).map(r=>[r.key,r.value]));
    return {...pending,lastSuccessAt:Number(settings.lastSuccessAt??0),retryAt:Number(settings.retryAt??0),failures:Number(settings.failures??0),blockedReason:settings.blockedReason||null};
  }

  ensureBackupDestination(fingerprint:string){
    const old=this.db.prepare("SELECT value FROM backup_schedule WHERE key='destination'").get() as {value:string}|undefined;
    this.db.transaction(()=>{
      if(old&&old.value!==fingerprint)this.backupDestinationChanged();
      this.db.prepare("INSERT OR REPLACE INTO backup_schedule VALUES ('destination',?)").run(fingerprint);
    })();
  }

  backupDestinationChanged(){
    this.db.transaction(()=>{
      this.db.prepare("DELETE FROM backup_schedule WHERE key IN ('lastSuccessAt','retryAt','failures','blockedReason')").run();
      this.markBackupChange();
    })();
  }

  backupSucceeded(revision:number) {
    this.db.transaction(()=>{
      this.db.prepare("DELETE FROM backup_changes WHERE sequence<=?").run(revision);
      const put=this.db.prepare("INSERT OR REPLACE INTO backup_schedule VALUES (?,?)");
      for(const [key,value] of Object.entries({lastSuccessAt:String(Date.now()),retryAt:"0",failures:"0",blockedReason:""}))put.run(key,value);
    })();
  }

  backupFailed(error:string) {
    this.db.transaction(()=>{
      const failures=this.backupScheduleState().failures+1;
      const blocked=["BACKUP_ABNORMAL_DROP","RESTORE_RECOVERY_REQUIRED","BACKUP_PROTECTED","INVALID_BACKUP_MANIFEST"].includes(error)?error:"";
      const retryAt=Date.now()+Math.min(3600_000,60_000*2**Math.min(failures-1,6));
      const put=this.db.prepare("INSERT OR REPLACE INTO backup_schedule VALUES (?,?)");
      for(const [key,value] of Object.entries({failures:String(failures),retryAt:String(retryAt),blockedReason:blocked}))put.run(key,value);
    })();
  }

  close(): void {
    this.db.close();
  }
}
