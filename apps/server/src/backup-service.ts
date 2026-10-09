import { AsyncLocalStorage } from "node:async_hooks";
import { BackupRunMetrics } from "./backup-observability.js";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, rm, writeFile, statfs, stat } from "node:fs/promises";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { BackupCache, type CachedFile } from "./backup-cache.js";
import {
  GetObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export interface BackupFile {
  path: string;
  size: number;
  sha256: string;
}

export interface BackupManifest {
  version: 1;
  id: string;
  createdAt: string;
  reason: "manual" | "scheduled" | "pre-restore";
  files: BackupFile[];
  protected?: boolean;
}

export interface BackupConfig {
  enabled: boolean;
  bucket: string;
  prefix: string;
  retention: number;
  intervalHours: number;
  verifyIntervalHours?: number;
  endpoint?: string;
  serverSideEncryption?: "AES256" | "aws:kms";
  kmsKeyId?: string;
}

interface S3Transport {
  send(command: unknown, options?: { abortSignal: AbortSignal }): Promise<any>;
  destroy?: () => void;
}

function cleanPrefix(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

async function bodyToBuffer(body: any): Promise<Buffer> {
  if (!body) throw new Error("S3_OBJECT_BODY_MISSING");
  if (typeof body.transformToByteArray === "function") {
    return Buffer.from(await body.transformToByteArray());
  }
  if (body instanceof Uint8Array) return Buffer.from(body);
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function parallelFiles<T>(items: T[], action: (item: T) => Promise<void>): Promise<void> {
  const configured = Number(process.env.S3_BACKUP_CONCURRENCY ?? 8);
  const concurrency = Number.isFinite(configured) ? Math.max(1, Math.min(16, Math.floor(configured))) : 8;
  let next = 0;
  let failed = false;
  const results = await Promise.allSettled(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failed) {
      const index = next++;
      if (index >= items.length) return;
      try { await action(items[index]); } catch (error) { failed = true; throw error; }
    }
  }));
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

export class BackupService {
  private runContext=new AsyncLocalStorage<BackupRunMetrics>();
  private runMetrics?:BackupRunMetrics;
  private runResult?:ReturnType<BackupRunMetrics["snapshot"]>;
  private async measured<T>(kind:"backup"|"restore",action:()=>Promise<T>):Promise<T>{
    if(this.running)throw new Error("S3_BACKUP_BUSY");
    const metrics=new BackupRunMetrics(kind);this.runMetrics=metrics;this.runResult=undefined;
    return this.runContext.run(metrics,async()=>{try{return await action();}finally{metrics.finish();this.runResult=metrics.snapshot();}});
  }
  private phase(name:string){this.runContext.getStore()?.phase(name);this.progress.phase=name;}
  private async send(command:any,options?:{abortSignal:AbortSignal}):Promise<any>{
    const trace=this.runContext.getStore();if(!trace)return this.requireS3().send(command,options);
    const name=command.constructor.name.replace(/Command$/,"");
    const op=trace.operations[name]??={calls:0,errors:0,attempts:0,retryDelayMs:0,durationMs:0};op.calls++;
    const start=performance.now();const endPut=name==="PutObject"?trace.beginPut():undefined;
    try{
      const response=await this.requireS3().send(command,options);
      op.attempts+=response.$metadata?.attempts??1;op.retryDelayMs+=response.$metadata?.totalRetryDelay??0;
      if(name==="PutObject")trace.putBytes+=command.input.Body?.byteLength??0;
      if(name==="GetObject" && response.Body){
        const body=response.Body;
        response.Body={destroy:(error?:Error)=>body.destroy?.(error),transformToByteArray:async()=>{
          const streamStart=performance.now();try{const data=await bodyToBuffer(body);trace.getBytes+=data.length;return data;}
          catch(error){op.errors++;throw error;}finally{op.durationMs+=performance.now()-streamStart;}
        }};
      }
      return response;
    }catch(error:any){if(error?.$metadata?.httpStatusCode!==304&&error?.name!=="NotModified")op.errors++;op.attempts+=error?.$metadata?.attempts??1;op.retryDelayMs+=error?.$metadata?.totalRetryDelay??0;throw error;}
    finally{op.durationMs+=performance.now()-start;endPut?.();}
  }
  private cacheInstance?: BackupCache;
  private get cache(): BackupCache {
    return this.cacheInstance ??= new BackupCache(this.dataRoot, JSON.stringify([this.config.endpoint ?? "",this.config.bucket,this.config.prefix]));
  }
  close() { this.cacheInstance?.close(); this.cacheInstance=undefined; }
  private metrics = { logicalFiles:0,logicalBytes:0,hashedFiles:0, hashedBytes:0, reusedHashes:0, uploadedFiles:0, uploadedBytes:0, skipped:false, fullCheck:false };
  private summaries?: {at:number;items:ReturnType<BackupService["summary"]>[]};
  private manifestReads = new Map<string, Promise<BackupManifest>>();
  private running = false;
  private restoring = false;
  private cleanupError = "";
  private timer?: NodeJS.Timeout;
  private lastError = "";
  private lastBackup?: BackupManifest;
  private progress = {phase:"idle",totalFiles:0,completedFiles:0,totalBytes:0,completedBytes:0,startedAt:0,lastProgressAt:0};
  private advance(size:number){this.progress.completedFiles++;this.progress.completedBytes+=size;this.progress.lastProgressAt=Date.now();}


  async protection(): Promise<{ phase: string; snapshotId?: string; staging?:string; rollback?:string } | null> {
    try { return JSON.parse(await readFile(path.join(this.dataRoot, ".backup-protection.json"), "utf8")); }
    catch (error: any) { if (error.code === "ENOENT") return null; throw error; }
  }

  private async protect(phase: string, snapshotId?: string, locations?:{staging:string;rollback:string}): Promise<void> {
    const file = path.join(this.dataRoot, ".backup-protection.json");
    await writeFile(file + ".tmp", JSON.stringify({ phase, snapshotId, ...locations }));
    await rename(file + ".tmp", file);
  }

  async assertWritable(): Promise<void> {
    if (this.restoring || await this.protection()) throw new Error("BACKUP_PROTECTED");
  }


  constructor(
    private readonly dataRoot: string,
    readonly config: BackupConfig,
    private s3: S3Transport | undefined,
    private readonly onRestored: () => Promise<void>,
  ) {}

  reconfigure(config: BackupConfig, transport: S3Transport | undefined) {
    if(this.running)throw new Error("S3_BACKUP_BUSY");
    this.close();this.s3?.destroy?.();
    Object.assign(this.config,config);this.s3=transport;
    this.summaries=undefined;this.manifestReads.clear();this.lastBackup=undefined;
    this.lastError="";this.cleanupError="";this.runResult=undefined;
  }

  static async recoverInterruptedSwitch(root:string):Promise<boolean>{
    let state:any;
    try{state=JSON.parse(await readFile(path.join(root,".backup-protection.json"),"utf8"));}
    catch(e:any){if(e.code==="ENOENT")return false;throw e;}
    if(state.phase!=="switching")return false;
    if(!state.staging || !state.rollback || path.dirname(state.staging)!==root || path.dirname(state.rollback)!==root || !path.basename(state.staging).startsWith(".restore-") || !path.basename(state.rollback).startsWith(".rollback-"))throw new Error("RESTORE_RECOVERY_REQUIRED");
    // Roll back any completed directory moves. Preserve interrupted new files too.
    for(const name of ["notes","attachments"]){
      const old=path.join(state.rollback,name);
      try{await stat(old);}catch(e:any){if(e.code==="ENOENT")continue;throw e;}
      const current=path.join(root,name);
      try{await rename(current,path.join(root,`.interrupted-${name}-${randomUUID()}`));}catch(e:any){if(e.code!=="ENOENT")throw e;}
      await rename(old,current);
    }
    const file=path.join(root,".backup-protection.json");
    await writeFile(file+".tmp",JSON.stringify({phase:"downloading",snapshotId:state.snapshotId}));await rename(file+".tmp",file);
    return true;
  }

  static fromEnvironment(dataRoot: string, onRestored: () => Promise<void>): BackupService {
    const enabled = process.env.S3_BACKUP_ENABLED === "true";
    const bucket = process.env.S3_BACKUP_BUCKET ?? "";
    const accessKeyId = process.env.S3_BACKUP_ACCESS_KEY_ID ?? "";
    const secretAccessKey = process.env.S3_BACKUP_SECRET_ACCESS_KEY ?? "";
    const configured = enabled && Boolean(bucket && accessKeyId && secretAccessKey);
    const client = configured
      ? new S3Client({
          region: process.env.S3_BACKUP_REGION ?? "ap-guangzhou",
          endpoint: process.env.S3_BACKUP_ENDPOINT || undefined,
          forcePathStyle: process.env.S3_BACKUP_FORCE_PATH_STYLE === "true",
          credentials: { accessKeyId, secretAccessKey },
        })
      : undefined;
    return new BackupService(
      dataRoot,
      {
        enabled: configured,
        bucket,
        prefix: cleanPrefix(process.env.S3_BACKUP_PREFIX ?? "mynote"),
        retention: Math.max(1, Number(process.env.S3_BACKUP_RETENTION ?? 30)),
        intervalHours: Math.max(1, Number(process.env.S3_BACKUP_INTERVAL_HOURS ?? 24)),
        verifyIntervalHours: Math.max(1, Number(process.env.S3_BACKUP_VERIFY_INTERVAL_HOURS ?? 168)),
        endpoint: process.env.S3_BACKUP_ENDPOINT ?? "",
        serverSideEncryption: process.env.S3_BACKUP_SERVER_SIDE_ENCRYPTION === "aws:kms"
          ? "aws:kms"
          : process.env.S3_BACKUP_SERVER_SIDE_ENCRYPTION === "none"
            ? undefined
            : "AES256",
        kmsKeyId: process.env.S3_BACKUP_KMS_KEY_ID || undefined,
      },
      client,
      onRestored,
    );
  }

  status() {
    return {
      progress: {...this.progress},
      telemetry:this.runResult??this.runMetrics?.snapshot()??null,
      configured: this.config.enabled,
      running: this.running,
      lastBackup: this.lastBackup ? this.summary(this.lastBackup) : null,
      metrics: {...this.metrics},
      verifyIntervalHours: this.config.verifyIntervalHours ?? 168,
      lastError: this.lastError || null,
      cleanupError: this.cleanupError || null,
      retention: this.config.retention,
      intervalHours: this.config.intervalHours,
    };
  }

  startScheduler(onError: (error: unknown) => void): void {
    if (!this.config.enabled || this.timer) return;
    this.timer = setInterval(() => {
      void this.createSnapshot("scheduled").catch(onError);
    }, this.config.intervalHours * 3600_000);
    this.timer.unref();
  }

  stopScheduler(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private requireS3(): S3Transport {
    if (!this.config.enabled || !this.s3) throw new Error("S3_BACKUP_NOT_CONFIGURED");
    return this.s3;
  }

  private key(suffix: string): string {
    return this.config.prefix ? `${this.config.prefix}/${suffix}` : suffix;
  }

  private encryptionHeaders() {
    return this.config.serverSideEncryption
      ? {
          ServerSideEncryption: this.config.serverSideEncryption,
          SSEKMSKeyId: this.config.serverSideEncryption === "aws:kms" ? this.config.kmsKeyId : undefined,
        }
      : {};
  }

  private async localFiles(root: string, fullCheck: boolean): Promise<Array<BackupFile & { absolutePath: string }>> {
    const output: Array<BackupFile & { absolutePath: string }> = [];
    const cached = this.cache.files();
    const changed: CachedFile[] = [];
    const visit = async (rootName: "notes" | "attachments", directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(rootName, absolutePath);
        if (!entry.isFile()) continue;
        const relative = path.posix.join(rootName, path.relative(path.join(root, rootName), absolutePath).split(path.sep).join("/"));
        // Atomic replacement changes inode/birth time even when length and mtime are equal.
        // ctime is deliberately excluded: capturing/releasing a hard link changes it.
        const before = await stat(absolutePath, {bigint:true});
        const signature = [before.dev,before.ino,before.birthtimeNs,before.size,before.mtimeNs].join(":");
        const old = cached.get(relative);
        let hash: string;
        if (!fullCheck && old?.signature === signature && /^[a-f0-9]{64}$/.test(old.sha256)) {
          hash=old.sha256; this.metrics.reusedHashes++;
        } else {
          const data=await readFile(absolutePath);
          const after=await stat(absolutePath,{bigint:true});
          if(before.size!==after.size || before.mtimeNs!==after.mtimeNs || before.ctimeNs!==after.ctimeNs) throw new Error("BACKUP_SOURCE_CHANGED");
          hash=sha256(data); this.metrics.hashedFiles++; this.metrics.hashedBytes+=data.length;
        }
        const file={path:relative,size:Number(before.size),sha256:hash};
        output.push({...file,absolutePath}); changed.push({...file,signature});
      }
    };
    for (const rootName of ["notes", "attachments"] as const) {
      const directory = path.join(root, rootName);
      await mkdir(directory, { recursive: true });
      await visit(rootName, directory);
    }
    this.cache.saveFiles(changed);
    if(fullCheck)this.cache.set("localCheck",String(Date.now()));
    return output.sort((left, right) => left.path.localeCompare(right.path));
  }

  // Notes and attachments are replaced atomically; hard links pin their old inodes.
  private async captureFiles(destination: string): Promise<void> {
    const visit = async (source: string, target: string): Promise<void> => {
      await mkdir(target, { recursive: true });
      for (const entry of await readdir(source, { withFileTypes: true })) {
        if (entry.isDirectory()) await visit(path.join(source, entry.name), path.join(target, entry.name));
        else if (entry.isFile()) await link(path.join(source, entry.name), path.join(target, entry.name));
      }
    };
    for (const name of ["notes", "attachments"]) {
      await mkdir(path.join(this.dataRoot, name), { recursive: true });
      await visit(path.join(this.dataRoot, name), path.join(destination, name));
    }
  }

  private async blobInventory(): Promise<Map<string, number>> {
    const objects = new Map<string, number>();
    let token: string | undefined;
    do {
      const response = await this.send(new ListObjectsV2Command({
        Bucket: this.config.bucket, Prefix: this.key("blobs/"), ContinuationToken: token,
      }));
      for (const item of response.Contents ?? []) {
        const hash = item.Key?.slice(this.key("blobs/").length);
        if (/^[a-f0-9]{64}$/.test(hash) && Number.isSafeInteger(item.Size)) objects.set(hash, item.Size);
      }
      if (response.IsTruncated && (!response.NextContinuationToken || response.NextContinuationToken === token)) throw new Error("S3_INVALID_PAGINATION");
      token = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (token);
    return objects;
  }

  async createSnapshot(reason:BackupManifest["reason"]="manual",enforceRetention=true,capture:(action:()=>Promise<void>)=>Promise<void>=action=>action()):Promise<BackupManifest>{
    return this.measured("backup",()=>this.createSnapshotInner(reason,enforceRetention,capture));
  }

  private async createSnapshotInner(
    reason: BackupManifest["reason"] = "manual",
    enforceRetention = true,
    capture: (action: () => Promise<void>) => Promise<void> = action => action(),
  ): Promise<BackupManifest> {
    if (this.running) throw new Error("S3_BACKUP_BUSY");
    this.running = true;
    this.lastError = "";
    this.cleanupError = "";
    this.metrics={logicalFiles:0,logicalBytes:0,hashedFiles:0,hashedBytes:0,reusedHashes:0,uploadedFiles:0,uploadedBytes:0,skipped:false,fullCheck:false};
    const staging = path.join(this.dataRoot, ".backup-capture");
    try {
      if (await this.protection()) throw new Error("BACKUP_PROTECTED");
      this.progress={phase:"scanning",totalFiles:0,completedFiles:0,totalBytes:0,completedBytes:0,startedAt:Date.now(),lastProgressAt:0};
      await rm(staging, { recursive: true, force: true });
      this.phase("capturing");
      const waiting=performance.now();
      await capture(async()=>{
        const locked=performance.now();this.runMetrics!.queueWaitMs+=locked-waiting;
        try{await this.captureFiles(staging);}finally{this.runMetrics!.writeLockMs+=performance.now()-locked;}
      });
      this.phase("scanning");
      const verifyMs=(this.config.verifyIntervalHours ?? 168)*3600_000;
      const due=(key:string)=>{const at=Number(this.cache.get(key)??0);return !Number.isFinite(at)||at<=0||Date.now()<at||Date.now()-at>=verifyMs;};
      const localCheck=due("localCheck"), remoteCheck=due("remoteCheck");
      this.metrics.fullCheck=localCheck||remoteCheck;
      const localFiles = await this.localFiles(staging,localCheck);
      this.metrics.logicalFiles=localFiles.length;this.metrics.logicalBytes=localFiles.reduce((n,f)=>n+f.size,0);
      this.phase("manifests");
      const snapshots = await this.listSnapshots();
      for (const previous of snapshots) {
        for (const root of ["notes/", "attachments/"]) {
          const before = previous.files.filter(f => f.path.startsWith(root));
          const after = localFiles.filter(f => f.path.startsWith(root));
          const bytes = (files: BackupFile[]) => files.reduce((sum, f) => sum + f.size, 0);
          if (before.length && (!after.length || after.length <= before.length * 0.5 || bytes(before) > 0 && bytes(after) <= bytes(before) * 0.5)) {
            throw new Error("BACKUP_ABNORMAL_DROP");
          }
        }
      }
      const uniqueFiles = [...new Map(localFiles.map((file) => [file.sha256, file])).values()];
      this.phase("uploading");this.progress.totalFiles=uniqueFiles.length;this.progress.totalBytes=uniqueFiles.reduce((n,f)=>n+f.size,0);
      let inventory = this.cache.objects();
      if(remoteCheck) { this.phase("inventory");inventory=await this.blobInventory();this.cache.replaceObjects(inventory,Date.now()); }
      this.phase("uploading");
      await parallelFiles(uniqueFiles, async (file) => {
        const blobKey = this.key(`blobs/${file.sha256}`);
        if (inventory.get(file.sha256) === file.size) {this.advance(file.size);return;}
        await this.send(new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: blobKey,
          Body: await this.verifiedLocalFile(file),
          ContentType: "application/octet-stream",
          Metadata: { sha256: file.sha256 },
          ...this.encryptionHeaders(),
        }));
        this.cache.confirm(file.sha256,file.size);
        this.metrics.uploadedFiles++;this.metrics.uploadedBytes+=file.size;
        this.advance(file.size);
      });
      this.phase("comparing");
      const latest = snapshots.length ? await this.latestManifest() : undefined;
      const sameFiles = latest && latest.files.length===localFiles.length && (()=>{
        const previous=new Map(latest.files.map(f=>[f.path,f]));
        return localFiles.every(f=>{const old=previous.get(f.path);return old?.sha256===f.sha256 && old.size===f.size;});
      })();
      if (reason!=="pre-restore" && latest && sameFiles && snapshots.some(s=>s.id===latest.id)) {
        this.lastBackup=latest;this.metrics.skipped=true;
        if(enforceRetention && (this.cache.get("cleanupPending")==="true" || remoteCheck)) await this.cleanup(latest.id);
        this.phase("completed");
        return latest;
      }
      this.phase("publishing");
      const createdAt = new Date().toISOString();
      const id = `${createdAt.replace(/[:.]/g, "-")}-${randomUUID()}`;
      const manifest: BackupManifest = {
        version: 1,
        id,
        createdAt,
        reason,
        protected: reason === "pre-restore",
        files: localFiles.map(({ absolutePath: _, ...file }) => file),
      };
      const body = gzipSync(Buffer.from(JSON.stringify(manifest)));
      this.cache.set("cleanupPending","true");
      const published = await this.send(new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: this.key(`snapshots/${id}.json`),
        Body: body,
        ContentEncoding: "gzip",
        ContentType: "application/json",
        ...this.encryptionHeaders(),
      }));
      this.cache.saveManifest(this.key(`snapshots/${id}.json`),published.ETag,body);
      await this.send(new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: this.key("latest.json"),
        Body: Buffer.from(JSON.stringify({version:2,id,manifestKey:`snapshots/${id}.json`})),
        ContentType: "application/json",
        ...this.encryptionHeaders(),
      }));
      this.lastBackup = manifest;
      this.phase("completed");
      this.summaries=undefined;
      if (enforceRetention) await this.cleanup(manifest.id);
      this.phase("completed");
      return manifest;
    } catch (error) {
      if(this.runMetrics)this.runMetrics.failedPhase=this.progress.phase;
      this.phase("failed");
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      const resultPhase=this.progress.phase;this.phase("releasing");
      try { await rm(staging, { recursive: true, force: true }); }
      finally { this.phase(resultPhase);this.running = false; }
    }
  }

  private async download(key: string, ifNoneMatch?: string, onEtag?: (etag:string|undefined)=>void): Promise<Buffer> {
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      let body: any;
      const timeout = setTimeout(() => { controller.abort(); body?.destroy?.(new Error("S3_DOWNLOAD_TIMEOUT")); }, 180_000);
      try {
        const response = await this.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key, ...(ifNoneMatch?{IfNoneMatch:ifNoneMatch}:{}) }), { abortSignal: controller.signal });
        onEtag?.(response.ETag);
        body = response.Body;
        return await bodyToBuffer(body);
      } catch (error: any) {
        const status = error?.$metadata?.httpStatusCode;
        const transient = controller.signal.aborted || status === 429 || status >= 500 || /aborted|timeout|timed out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(String(error));
        if (!transient || attempt >= 4) throw error;
      } finally { clearTimeout(timeout); body?.destroy?.(); }
      await new Promise(resolve => setTimeout(resolve, 200 * 2 ** attempt));
    }
  }

  private decode(body: Buffer): any {
    return JSON.parse((body[0]===0x1f && body[1]===0x8b ? gunzipSync(body) : body).toString("utf8"));
  }

  private async jsonForKey(key: string, etag?: string): Promise<any> {
    const cached=this.cache.manifest(key);
    if(etag && cached?.etag===etag) return this.decode(cached.body);
    try {
      let responseEtag:string|undefined;
      const body=await this.download(key,cached?.etag,etag=>{responseEtag=etag;});
      const value=this.decode(body);
      this.cache.saveManifest(key,responseEtag,gzipSync(Buffer.from(JSON.stringify(value))));
      return value;
    } catch(error:any) {
      if(cached && (error?.$metadata?.httpStatusCode===304 || error?.name==="NotModified"))return this.decode(cached.body);
      throw error;
    }
  }

  private async manifestForKey(key: string, etag?: string): Promise<BackupManifest> {
    const identity=key+":"+(etag??"");
    const existing=this.manifestReads.get(identity);if(existing)return existing;
    const request=(async()=>{
      const value=await this.jsonForKey(key,etag);
      this.validateManifest(value);
      if(key!==this.key(`snapshots/${value.id}.json`))throw new Error("INVALID_BACKUP_MANIFEST");
      return value as BackupManifest;
    })();
    this.manifestReads.set(identity,request);
    try{return await request;}finally{this.manifestReads.delete(identity);}
  }

  private async latestManifest(): Promise<BackupManifest> {
    const latest=await this.jsonForKey(this.key("latest.json"));
    if(latest.version===2) {
      if(typeof latest.id!=="string" || !/^[\w-]+$/.test(latest.id) || latest.manifestKey!==`snapshots/${latest.id}.json`)throw new Error("INVALID_BACKUP_MANIFEST");
      return this.manifestForKey(this.key(latest.manifestKey));
    }
    this.validateManifest(latest);return latest;
  }

  async listSnapshots(): Promise<BackupManifest[]> {
    const entries: {key:string;etag?:string}[]=[];
    let token: string|undefined;
    do {
      const r=await this.send(new ListObjectsV2Command({Bucket:this.config.bucket,Prefix:this.key("snapshots/"),ContinuationToken:token}));
      for(const item of r.Contents??[])if(item.Key?.endsWith(".json"))entries.push({key:item.Key,etag:item.ETag});
      if(r.IsTruncated&&(!r.NextContinuationToken||r.NextContinuationToken===token))throw new Error("S3_INVALID_PAGINATION");
      token=r.IsTruncated?r.NextContinuationToken:undefined;
    }while(token);
    const result:BackupManifest[]=[];
    await parallelFiles(entries,async item=>{result.push(await this.manifestForKey(item.key,item.etag));});
    return result.sort((a,b)=>b.id.localeCompare(a.id));
  }

  summary(manifest:BackupManifest) {
    return {id:manifest.id,createdAt:manifest.createdAt,reason:manifest.reason,protected:manifest.protected,fileCount:manifest.files.length,totalBytes:manifest.files.reduce((n,f)=>n+f.size,0)};
  }

  async listSummaries() {
    if(this.summaries && Date.now()-this.summaries.at<60_000)return this.summaries.items;
    const items=(await this.listSnapshots()).map(m=>this.summary(m));
    this.summaries={at:Date.now(),items};return items;
  }

  private async cleanup(latestId:string) {
    this.phase("cleaning");
    try {
      for(let attempt=0;;attempt++){
        try{await this.applyRetention(latestId);break;}
        catch(error){
          if(!(error instanceof Error)||error.message!=="S3_LATEST_CHANGED"||attempt>=2)throw error;
          // A delayed list/read after publishing must never authorize deletion.
          // Recheck with a fresh pointer; persistent disagreement stays protected.
          this.cache.forgetManifest(this.key("latest.json"));
          await new Promise(resolve=>setTimeout(resolve,200*2**attempt));
        }
      }
      this.cache.set("cleanupPending","false");
    }
    catch(error) {this.cleanupError=error instanceof Error?error.message:String(error);this.cache.set("cleanupPending","true");}
    finally{this.summaries=undefined;}
  }

  private async verifiedLocalFile(file: BackupFile & { absolutePath: string }): Promise<Buffer> {
    const data = await readFile(file.absolutePath);
    if (data.length !== file.size || sha256(data) !== file.sha256) throw new Error("BACKUP_SOURCE_CHANGED");
    return data;
  }

  private validateManifest(manifest: BackupManifest): void {
    if (manifest.version !== 1 || typeof manifest.id !== "string" || !/^[\w-]+$/.test(manifest.id) || !Number.isFinite(Date.parse(manifest.createdAt)) || !Array.isArray(manifest.files)) throw new Error("INVALID_BACKUP_MANIFEST");
    const paths = new Set<string>();
    for (const file of manifest.files) {
      if (!/^(notes|attachments)\//.test(file.path) || file.path.includes("\\") || file.path.split("/").some(p => !p || p === "." || p === "..") || paths.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error("INVALID_BACKUP_MANIFEST");
      paths.add(file.path);
    }
  }

  private async deleteKeys(keys: string[]): Promise<void> {
    for (let offset = 0; offset < keys.length; offset += 1000) {
      const result = await this.send(new DeleteObjectsCommand({
        Bucket: this.config.bucket, Delete: { Objects: keys.slice(offset, offset + 1000).map(Key => ({ Key })), Quiet: true },
      }));
      if (result.Errors?.length) throw new Error("S3_CLEANUP_PARTIAL_FAILURE");
    }
  }

  private async applyRetention(latestId: string): Promise<void> {
    // Single server owns this prefix; backup/restore jobs are serialized.
    const snapshots = await this.listSnapshots();
    const latest = await this.latestManifest();
    this.validateManifest(latest);
    if (latest.id !== latestId || !snapshots.some(s => s.id === latestId)) throw new Error("S3_LATEST_CHANGED");
    const retention = this.config.retention;
    if (!Number.isSafeInteger(retention) || retention < 1) throw new Error("INVALID_BACKUP_RETENTION");
    let ordinary = latest.protected || latest.reason === "pre-restore" ? 0 : 1;
    const expired = snapshots.filter(s => s.id !== latestId && !s.protected && s.reason !== "pre-restore" && ++ordinary > retention);
    await this.deleteKeys(expired.map(s => this.key(`snapshots/${s.id}.json`)));
    for(const s of expired)this.cache.forgetManifest(this.key(`snapshots/${s.id}.json`));
    // Re-read after deletion. A failed deletion never proceeds to blob GC.
    const remaining = await this.listSnapshots();
    if (!remaining.some(s => s.id === latestId)) throw new Error("S3_LATEST_CHANGED");
    const referenced = new Set([...remaining, latest].flatMap(s => s.files.map(f => f.sha256)));
    const inventory = this.cache.objects();
    const unused=[...inventory.keys()].filter(hash=>!referenced.has(hash));
    // Invalidate before deletion: even a partially successful delete must never remain cached as present.
    for(const hash of unused)this.cache.forget(hash);
    try{await this.deleteKeys(unused.map(hash=>this.key(`blobs/${hash}`)));}
    catch(error){this.cache.set("remoteCheck","0");throw error;}
  }

  async restore(snapshotId:string,verifiedManifest?:BackupManifest):Promise<BackupManifest>{return this.measured("restore",()=>this.restoreInner(snapshotId,verifiedManifest));}

  private async restoreInner(snapshotId: string, verifiedManifest?: BackupManifest): Promise<BackupManifest> {
    if (!/^[\w-]+$/.test(snapshotId)) throw new Error("INVALID_SNAPSHOT_ID");
    if (this.running) throw new Error("S3_BACKUP_BUSY");
    const previous = await this.protection();
    if (previous?.phase === "switching") throw new Error("RESTORE_RECOVERY_REQUIRED");
    this.running = true;
    this.restoring = true;
    this.metrics={logicalFiles:0,logicalBytes:0,hashedFiles:0,hashedBytes:0,reusedHashes:0,uploadedFiles:0,uploadedBytes:0,skipped:false,fullCheck:false};
    this.lastError = "";
    const staging = path.join(this.dataRoot, `.restore-${sha256(Buffer.from(this.config.bucket + "/" + this.config.prefix + "/" + snapshotId))}`);
    const rollback = path.join(this.dataRoot, `.rollback-${randomUUID()}`);
    let movedNotes = false;
    let movedAttachments = false;
    try {
      this.progress={phase:"manifest",totalFiles:0,completedFiles:0,totalBytes:0,completedBytes:0,startedAt:Date.now(),lastProgressAt:0};
      this.phase("manifest");
      await this.protect("downloading", snapshotId);
      const manifest = verifiedManifest ?? await this.manifestForKey(this.key(`snapshots/${snapshotId}.json`));
      if (manifest.version !== 1 || manifest.id !== snapshotId || !Array.isArray(manifest.files)) throw new Error("INVALID_BACKUP_MANIFEST");
      const paths = new Set<string>();
      for (const file of manifest.files) {
        if (!/^(notes|attachments)\//.test(file.path) || file.path.includes("\\") || file.path.split("/").some(p => !p || p === "." || p === "..") || paths.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error("INVALID_BACKUP_MANIFEST");
        paths.add(file.path);
      }
      await Promise.all([
        mkdir(path.join(staging, "notes"), { recursive: true }),
        mkdir(path.join(staging, "attachments"), { recursive: true }),
      ]);
      this.phase("downloading");this.progress.totalFiles=manifest.files.length;this.progress.totalBytes=manifest.files.reduce((n,f)=>n+f.size,0);
      this.metrics.logicalFiles=this.progress.totalFiles;this.metrics.logicalBytes=this.progress.totalBytes;
      const disk=await statfs(this.dataRoot);
      let missingBytes=0;
      for(const file of manifest.files){try{const cached=await stat(path.join(staging,file.path));if(cached.size!==file.size)missingBytes+=file.size;}catch(e:any){if(e.code!=="ENOENT")throw e;missingBytes+=file.size;}}
      if(disk.bavail*disk.bsize < missingBytes*1.1+64*1024*1024)throw new Error("RESTORE_DISK_SPACE_LOW");
      await parallelFiles(manifest.files, async (file) => {
        if (!/^(notes|attachments)\//.test(file.path) || file.path.split("/").includes("..")) {
          throw new Error("INVALID_BACKUP_PATH");
        }
        const destination = path.join(staging, ...file.path.split("/"));
        try {
          const existing = await readFile(destination);
          if (existing.length === file.size && sha256(existing) === file.sha256) {this.advance(file.size);return;}
        } catch (error: any) { if (error.code !== "ENOENT") throw error; }
        const data = await this.download(this.key(`blobs/${file.sha256}`));
        if (data.length !== file.size || sha256(data) !== file.sha256) throw new Error("BACKUP_CHECKSUM_MISMATCH");
        await mkdir(path.dirname(destination), { recursive: true });
        const partial = path.join(staging, ".partial-" + randomUUID());
        await writeFile(partial, data);
        await rename(partial, destination);
        this.advance(file.size);
      });

      this.phase("switching");
      await this.protect("switching", snapshotId, {staging,rollback});
      await mkdir(rollback, { recursive: true });
      await rename(path.join(this.dataRoot, "notes"), path.join(rollback, "notes"));
      movedNotes = true;
      await rename(path.join(this.dataRoot, "attachments"), path.join(rollback, "attachments"));
      movedAttachments = true;
      await rename(path.join(staging, "notes"), path.join(this.dataRoot, "notes"));
      await rename(path.join(staging, "attachments"), path.join(this.dataRoot, "attachments"));
      await this.onRestored();
      this.cache.saveFiles([]);this.cache.set("localCheck","0");
      // Preserve rollback data until explicitly reviewed by the operator.
      await rm(staging, { recursive: true, force: true });
      await rm(path.join(this.dataRoot, ".backup-protection.json"));
      this.phase("completed");
      return manifest;
    } catch (error) {
      if(this.runMetrics)this.runMetrics.failedPhase=this.progress.phase;
      this.phase("failed");
      this.lastError = error instanceof Error ? error.message : String(error);
      if (movedNotes) {
        await rm(path.join(this.dataRoot, "notes"), { recursive: true, force: true });
        await rename(path.join(rollback, "notes"), path.join(this.dataRoot, "notes"));
      }
      if (movedAttachments) {
        await rm(path.join(this.dataRoot, "attachments"), { recursive: true, force: true });
        await rename(path.join(rollback, "attachments"), path.join(this.dataRoot, "attachments"));
      }
      if (movedNotes || movedAttachments) {
        await this.onRestored();
      }
      // Keep validated downloads for a later resume; never discard failure evidence.
      throw error;
    } finally {
      this.running = false;
      this.restoring = false;
    }
  }
}
