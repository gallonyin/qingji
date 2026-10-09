import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type CachedFile = { path: string; signature: string; size: number; sha256: string };

/** Disposable acceleration data, separate from notes/history. Remote state is scoped to one destination. */
export class BackupCache {
  private db: Database.Database;
  constructor(root: string, private scope: string) {
    mkdirSync(root, { recursive: true });
    this.db = new Database(path.join(root, "backup-cache.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (scope TEXT, path TEXT, signature TEXT, size INTEGER, sha256 TEXT, PRIMARY KEY(scope,path));
      CREATE TABLE IF NOT EXISTS objects (scope TEXT, hash TEXT, size INTEGER, PRIMARY KEY(scope,hash));
      CREATE TABLE IF NOT EXISTS state (scope TEXT, key TEXT, value TEXT, PRIMARY KEY(scope,key));
      CREATE TABLE IF NOT EXISTS manifests (scope TEXT, key TEXT, etag TEXT, body BLOB, PRIMARY KEY(scope,key));
    `);
  }
  files(): Map<string, CachedFile> {
    return new Map((this.db.prepare("SELECT path,signature,size,sha256 FROM files WHERE scope=?").all(this.scope) as CachedFile[]).map(f=>[f.path,f]));
  }
  saveFiles(files: CachedFile[]) {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM files WHERE scope=?").run(this.scope);
      const put=this.db.prepare("INSERT INTO files VALUES (?,?,?,?,?)");
      for(const f of files) put.run(this.scope,f.path,f.signature,f.size,f.sha256);
    })();
  }
  objects(): Map<string, number> {
    return new Map((this.db.prepare("SELECT hash,size FROM objects WHERE scope=?").all(this.scope) as {hash:string;size:number}[]).map(o=>[o.hash,o.size]));
  }
  confirm(hash: string, size: number) { this.db.prepare("INSERT OR REPLACE INTO objects VALUES (?,?,?)").run(this.scope,hash,size); }
  replaceObjects(objects: Map<string, number>, checkedAt: number) {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM objects WHERE scope=?").run(this.scope);
      for (const [hash,size] of objects) this.confirm(hash,size);
      this.set("remoteCheck",String(checkedAt));
    })();
  }
  forget(hash: string) { this.db.prepare("DELETE FROM objects WHERE scope=? AND hash=?").run(this.scope,hash); }
  get(key: string): string | undefined { return (this.db.prepare("SELECT value FROM state WHERE scope=? AND key=?").get(this.scope,key) as {value:string}|undefined)?.value; }
  set(key: string,value: string) { this.db.prepare("INSERT OR REPLACE INTO state VALUES (?,?,?)").run(this.scope,key,value); }
  manifest(key: string) { return this.db.prepare("SELECT etag,body FROM manifests WHERE scope=? AND key=?").get(this.scope,key) as {etag:string;body:Buffer}|undefined; }
  saveManifest(key: string,etag: string|undefined,body: Buffer) { this.db.prepare("INSERT OR REPLACE INTO manifests VALUES (?,?,?,?)").run(this.scope,key,etag??"",body); }
  forgetManifest(key: string) { this.db.prepare("DELETE FROM manifests WHERE scope=? AND key=?").run(this.scope,key); }
  close() { this.db.close(); }
}
