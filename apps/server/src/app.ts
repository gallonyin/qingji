import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { ZipArchive } from "archiver";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import { BackupService } from "./backup-service.js";
import { MetadataDatabase } from "./database.js";
import { BackupScheduler, type BackupScheduleConfig } from "./backup-scheduler.js";
import { BackupJobs } from "./backup-jobs.js";
import { WriteQueue } from "./write-queue.js";
import { SettingsStore, GITHUB_URL, backupConfig, s3Transport, testS3, type S3Settings, type SettingsTransport } from "./settings.js";
import { NoteStore, deserialize } from "./note-store.js";

const noteInput = z.object({
  id: z.string().uuid().optional(),
  title: z.string().max(500).optional(),
  content: z.string().optional(),
  tags: z.array(z.string().max(100)).max(100).optional(),
  folder: z.string().max(1000).optional(),
  favorite: z.boolean().optional(),
});
const revision = z.coerce.number().int().positive();

export interface AppOptions {
  dataDir?: string;
  password?: string;
  cookieSecure?: boolean;
  backupService?: BackupService;
  backupSchedule?: BackupScheduleConfig;
  settingsTransport?: (config:S3Settings) => SettingsTransport;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(hash(left));
  const b = Buffer.from(hash(right));
  return timingSafeEqual(a, b);
}

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const dataDir = path.resolve(options.dataDir ?? process.env.MYNOTE_DATA_DIR ?? "./data");
  const password = options.password ?? process.env.MYNOTE_PASSWORD;
  if (!password || password === "change-this-password") throw new Error("MYNOTE_PASSWORD must be configured with a non-placeholder password");
  await mkdir(dataDir, { recursive: true });

  const app = Fastify({ logger: false });
  const rolledBack = await BackupService.recoverInterruptedSwitch(dataDir);
  const metadata = new MetadataDatabase(path.join(dataDir, "metadata.sqlite"));
  const writes = new WriteQueue();
  const store = new NoteStore(dataDir, metadata);
  await store.initialize();
  if(rolledBack)await store.scan(true);
  for (const change of metadata.pendingOperations()) {
    const result = {id:change.id,operationId:change.operationId,...(await store.applyPush(change))};
    metadata.saveOperation(change.operationId,result);
  }
  const settings = new SettingsStore(dataDir);
  await settings.initialize();
  const settingQueue = new WriteQueue();
  const makeTransport = options.settingsTransport ?? s3Transport;
  const initialS3 = settings.current().s3;
  const destination=(s:S3Settings)=>hash(JSON.stringify([s.endpoint,s.bucket,s.prefix,s.enabled]));
  metadata.ensureBackupDestination(destination(initialS3));
  const backups = options.backupService ?? new BackupService(dataDir,backupConfig(initialS3),backupConfig(initialS3).enabled?makeTransport(initialS3):undefined,async()=>{await store.scan(true);});

  const allowedOrigins = (process.env.MYNOTE_ORIGIN ?? "http://localhost:5173,http://localhost:1420")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  await app.register(cors, {
    origin: allowedOrigins,
    credentials: true,
    allowedHeaders: ["content-type", "authorization", "x-vault-epoch"],
  });
  await app.register(cookie);
  await app.register(rateLimit,{global:false,cache:1000});
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

  app.decorate("noteStore", store);
  app.decorate("backupService", backups);
  const jobs = new BackupJobs(dataDir,backups,writes,()=>{if(metadata.intents().length)throw new Error("RESTORE_RECOVERY_REQUIRED");},{
    checkpoint:()=>metadata.backupScheduleState().revision,
    finished:job=>{
      if(job.kind!=="backup")return;
      if(job.state==="succeeded" && job.capturedRevision!==undefined)metadata.backupSucceeded(job.capturedRevision);
      else if(job.state==="failed")metadata.backupFailed(job.error??"BACKUP_FAILED");
    },
  });
  await jobs.initialize();
  const scheduler=new BackupScheduler(metadata,jobs,backups,options.backupSchedule??{enabled:initialS3.scheduleEnabled,debounceSeconds:initialS3.debounceSeconds,maxWaitSeconds:initialS3.maxWaitSeconds,intervalHours:initialS3.intervalHours});
  scheduler.start(error=>app.log.error(error));
  app.addHook("onClose", async () => {
    backups.stopScheduler();
    await scheduler.close();
    await settingQueue.drain();
    await jobs.close();
    await writes.drain();
    backups.close();
    metadata.close();
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: "VALIDATION_ERROR", details: error.flatten() });
    const status: Record<string, number> = {
      SETTINGS_CONFLICT: 409,
      S3_SETTINGS_INCOMPLETE: 400,
      S3_TEST_CLEANUP_FAILED: 502,
      NOT_FOUND: 404,
      NOTE_IN_TRASH: 409,
      REVISION_CONFLICT: 409,
      ID_EXISTS: 409,
      INVALID_FOLDER: 400,
      PURGE_REQUIRES_TRASH: 400,
      INVALID_SNAPSHOT_ID: 400,
      RESTORE_CONFIRMATION_MISMATCH: 400,
      S3_BACKUP_BUSY: 409,
      BACKUP_PROTECTED: 409,
      EPOCH_CHANGED: 409,
      OPERATION_REUSED: 409,
      BACKUP_ABNORMAL_DROP: 409,
      RESTORE_RECOVERY_REQUIRED: 409,
      S3_BACKUP_NOT_CONFIGURED: 503,
    };
    const code = error instanceof Error ? error.message : "INTERNAL_ERROR";
    if(status[code])return reply.code(status[code]).send({error:code});
    const httpStatus=(error as {statusCode?:number}).statusCode;
    if(httpStatus===429)return reply.code(429).send({error:"RATE_LIMITED"});
    if(httpStatus===413)return reply.code(413).send({error:"PAYLOAD_TOO_LARGE"});
    if(httpStatus&&httpStatus>=400&&httpStatus<500)return reply.code(httpStatus).send({error:"INVALID_REQUEST"});
    app.log.error({err:error},"Request failed");
    return reply.code(500).send({ error: "INTERNAL_ERROR" });
  });

  app.get("/health", async () => ({ ok: true }));

  app.post("/auth/login", {config:{rateLimit:{max:10,timeWindow:60000}}}, async (request, reply) => {
    const body = z.object({ password: z.string() }).parse(request.body);
    if (!equalSecret(body.password, password)) return reply.code(401).send({ error: "INVALID_CREDENTIALS" });
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 30 * 24 * 3600_000);
    metadata.createSession(hash(token), expiresAt.toISOString());
    reply.setCookie("mynote_session", token, {
      httpOnly: true,
      sameSite: "strict",
      secure: options.cookieSecure ?? process.env.MYNOTE_COOKIE_SECURE === "true",
      path: "/",
      expires: expiresAt,
    });
    return { token, epoch: metadata.epoch(), expiresAt: expiresAt.toISOString() };
  });

  app.get("/auth/session", async () => ({ ok: true }));

  app.addHook("preHandler", async (request, reply) => {
    if (["/health","/auth/login","/branding","/branding/icon","/branding/manifest"].includes(request.url.split("?")[0])) return;
    if(backups.status().progress.phase==="switching" && !request.url.startsWith("/backups") && !request.url.startsWith("/backup-jobs")) return reply.code(503).send({error:"RESTORE_SWITCHING"});
    const bearer = request.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
    const token = bearer ?? request.cookies.mynote_session;
    if (!token || !metadata.hasSession(hash(token), new Date().toISOString())) {
      return reply.code(401).send({ error: "UNAUTHORIZED" });
    }
  });

  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    if (!methods.some(method => ["POST","PUT","PATCH","DELETE"].includes(method)) || route.url.startsWith("/auth/")) return;
    const handler = route.handler;
    route.handler = async function(request, reply) {
      if(route.url.startsWith("/settings"))return settingQueue.run(()=>Promise.resolve(handler.call(this,request,reply)));
      if (route.url.startsWith("/backups") || route.url.startsWith("/backup-jobs")) {
        if (metadata.intents().length) throw new Error("RESTORE_RECOVERY_REQUIRED");
        return settingQueue.run(()=>Promise.resolve(handler.call(this,request,reply)));
      }
      if(jobs.blocksWrites())throw new Error("BACKUP_PROTECTED");
      return writes.run(async () => {
        if(metadata.intents().length)throw new Error("RESTORE_RECOVERY_REQUIRED");
        if (!route.url.startsWith("/backups")) {
          await backups.assertWritable();
          if (request.headers["x-vault-epoch"] !== metadata.epoch()) throw new Error("EPOCH_CHANGED");
        }
        return handler.call(this,request,reply);
      });
    };
  });
  app.get("/sync/state", async () => ({epoch:metadata.epoch(),cursor:metadata.latestSequence()}));

  app.post("/auth/logout", async (request, reply) => {
    const token = request.headers.authorization?.match(/^Bearer (.+)$/i)?.[1] ?? request.cookies.mynote_session;
    if (token) metadata.deleteSession(hash(token));
    reply.clearCookie("mynote_session", { path: "/" });
    return { ok: true };
  });

  app.get("/notes", async (request) => {
    const query = z.object({ view: z.enum(["active", "recent", "favorites", "trash"]).default("active") }).parse(request.query);
    return { notes: store.list(query.view) };
  });
  app.post("/notes", async (request, reply) => reply.code(201).send({ note: await store.create(noteInput.parse(request.body)) }));
  app.get("/notes/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const note = store.get(id);
    return note ? { note } : reply.code(404).send({ error: "NOT_FOUND" });
  });
  app.patch("/notes/:id", async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = noteInput.extend({ revision }).parse(request.body);
    return { note: await store.update(id, body, body.revision) };
  });
  app.delete("/notes/:id", async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const query = z.object({ revision }).parse(request.query);
    return { note: await store.softDelete(id, query.revision) };
  });
  app.post("/notes/:id/restore", async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ revision }).parse(request.body);
    return { note: await store.restore(id, body.revision) };
  });
  app.delete("/notes/:id/permanent", async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const query = z.object({ revision }).parse(request.query);
    await store.purge(id, query.revision);
    return { ok: true };
  });
  app.get("/notes/:id/history", async (request) => {
    const {id}=z.object({id:z.string().uuid()}).parse(request.params);
    const query=z.object({before:z.coerce.number().int().positive().default(Number.MAX_SAFE_INTEGER),limit:z.coerce.number().int().min(1).max(100).default(20)}).parse(request.query);
    return store.history(id,query.before,query.limit);
  });
  app.get("/notes/:id/history/:historyId", async (request) => {
    const {id,historyId}=z.object({id:z.string().uuid(),historyId:z.coerce.number().int().positive()}).parse(request.params);
    return {note:store.historyVersion(id,historyId)};
  });
  app.post("/notes/:id/history/:historyId/restore", async (request) => {
    const {id,historyId}=z.object({id:z.string().uuid(),historyId:z.coerce.number().int().positive()}).parse(request.params);
    const {revision:expected}=z.object({revision}).parse(request.body);
    return {note:await store.restoreVersion(id,historyId,expected)};
  });

  app.get("/notes/:id/backlinks", async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return { notes: store.backlinks(id) };
  });
  app.post("/notes/:id/attachments", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: "FILE_REQUIRED" });
    return reply.code(201).send({ attachment: await store.saveAttachment(id, file.filename, await file.toBuffer()) });
  });
  app.get("/attachments/:noteId/:filename", async (request, reply) => {
    const { noteId, filename } = z.object({
      noteId: z.string().uuid(),
      filename: z.string().min(1).max(255),
    }).parse(request.params);
    const extension = path.extname(filename).toLowerCase();
    const contentTypes: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
      ".pdf": "application/pdf",
      ".txt": "text/plain; charset=utf-8",
    };
    reply.header("content-type", contentTypes[extension] ?? "application/octet-stream");
    reply.header("cache-control", "private, max-age=3600");
    reply.header("x-content-type-options","nosniff");
    // Direct navigation to SVG/PDF must not execute with the application's privileges.
    reply.header("content-security-policy","sandbox; default-src 'none'; style-src 'unsafe-inline'");
    return reply.send(await store.readAttachment(noteId, filename));
  });

  app.get("/search", async (request) => {
    const { q,summary } = z.object({ q: z.string().min(1),summary:z.enum(["1"]).optional() }).parse(request.query);
    const results=store.search(q);
    return { results:summary?results.map(({content,...note})=>({...note,excerpt:content.slice(0,72).replace(/[#*`>\n]/g," ")})):results };
  });
  app.post("/scan", async () => store.scan(true));

  app.get("/sync/pull", async (request) => {
    const query = z.object({
      until: z.coerce.number().int().nonnegative().optional(),
      since: z.coerce.number().int().nonnegative().default(0),
      limit: z.coerce.number().int().min(1).max(1000).default(200),
    }).parse(request.query);
    if (request.headers["x-vault-epoch"] && request.headers["x-vault-epoch"] !== metadata.epoch()) throw new Error("EPOCH_CHANGED");
    if (query.since > metadata.latestSequence()) throw new Error("EPOCH_CHANGED");
    const until = query.until ?? metadata.latestSequence();
    const page = metadata.pull(query.since, query.limit, until);
    return { ...page, until, epoch:metadata.epoch(), changes: page.events.map((event) => {
      const raw = metadata.revisionSnapshot(event.noteId,event.revision);
      const current = store.get(event.noteId);
      // The matching live revision is authoritative for legacy Markdown snapshots.
      const note = event.kind === "purge" ? null : current?.revision === event.revision ? current : raw ? (raw.startsWith("{") ? JSON.parse(raw) : deserialize(raw)) : null;
      return {...event,note};
    }) };
  });
  app.post("/sync/push", async (request) => {
    const body = z.object({
      changes: z.array(noteInput.extend({
        id: z.string().uuid(),
        operationId: z.string().uuid().optional(),
        baseRevision: z.number().int().nonnegative(),
        deleted: z.boolean().optional(),
        restored: z.boolean().optional(),
      })).max(1000),
    }).parse(request.body);
    const results: Array<Record<string, unknown>> = [];
    for (const change of body.changes) {
      if (change.operationId) metadata.beginOperation(change.operationId,change);
      const cached = change.operationId
        ? metadata.getOperation<Record<string, unknown>>(change.operationId)
        : undefined;
      if (cached) {
        results.push(cached);
        continue;
      }
      let applied;
      try { applied = await store.applyPush(change); }
      catch (error) {
        // A validation failure before journaling must not poison every restart.
        if (change.operationId && !metadata.intents().length) metadata.abandonOperation(change.operationId);
        throw error;
      }
      const result = { id: change.id, operationId: change.operationId, ...applied };
      if (change.operationId) metadata.saveOperation(change.operationId, result);
      results.push(result);
    }
    return { results, cursor: metadata.latestSequence() };
  });

  app.get("/export", async (_request, reply) => {
    const archive = new ZipArchive({ zlib: { level: 9 } });
    archive.directory(store.notesRoot, "notes");
    archive.directory(store.attachmentsRoot, "attachments");
    void archive.finalize();
    reply.header("content-type", "application/zip");
    reply.header("content-disposition", 'attachment; filename="mynote-export.zip"');
    return reply.send(archive);
  });

  app.get("/branding",async(_request,reply)=>{reply.header("cache-control","no-store");return {...settings.current().branding,githubUrl:GITHUB_URL};});
  app.get("/branding/icon",async(_request,reply)=>{
    const b=settings.current().branding;reply.header("cache-control","no-cache").header("x-content-type-options","nosniff");
    if(b.logoImage){const match=/^data:(image\/(?:png|jpeg|webp));base64,(.*)$/.exec(b.logoImage)!;return reply.type(match[1]).send(Buffer.from(match[2],"base64"));}
    const text=b.logoText.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[c]!));
    return reply.type("image/svg+xml").send(`<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 192 192"><rect width="192" height="192" rx="24" fill="#ac3528"/><text x="96" y="110" text-anchor="middle" fill="#fff9ef" font-size="64">${text}</text></svg>`);
  });
  app.get("/branding/manifest",async(_request,reply)=>{
    const b=settings.current().branding;reply.type("application/manifest+json").header("cache-control","no-cache");
    return {id:"/",name:b.name,short_name:b.name,start_url:"/",scope:"/",display:"standalone",background_color:"#f4f0e6",theme_color:"#ac3528",icons:[{src:"icon",sizes:"any",type:b.logoImage?b.logoImage.slice(5,b.logoImage.indexOf(';')):"image/svg+xml"}]};
  });
  app.get("/settings",async(_request,reply)=>{reply.header("cache-control","no-store");return settings.public();});
  app.put("/settings",async(request,reply)=>{
    const next=settings.candidate(request.body);
    const changed=JSON.stringify(next.s3)!==JSON.stringify(settings.current().s3);
    if(changed){
      await scheduler.close();
      try{
        if(jobs.busy()||backups.status().running)throw new Error("S3_BACKUP_BUSY");
        await backups.assertWritable();
        const transport=backupConfig(next.s3).enabled?makeTransport(next.s3):undefined;
        try{await settings.save(next);}catch(error){transport?.destroy?.();throw error;}
        backups.reconfigure(backupConfig(next.s3),transport);
        metadata.ensureBackupDestination(destination(next.s3));
        scheduler.configure({enabled:next.s3.scheduleEnabled,debounceSeconds:next.s3.debounceSeconds,maxWaitSeconds:next.s3.maxWaitSeconds,intervalHours:next.s3.intervalHours});
      }finally{scheduler.resume(error=>app.log.error(error));}
    }else await settings.save(next);
    console.info(JSON.stringify({event:"settings.updated",revision:next.revision,s3Changed:changed,backupEnabled:next.s3.enabled,automationEnabled:next.s3.scheduleEnabled}));
    reply.header("cache-control","no-store");return settings.public();
  });
  app.post("/settings/s3/test",{config:{rateLimit:{max:5,timeWindow:60000}}},async(request)=>{
    const config=settings.testCandidate(request.body),transport=makeTransport(config);
    try{const result=await testS3(config,transport);console.info(JSON.stringify({event:"settings.s3_test",...result}));return result;}catch(error){console.info(JSON.stringify({event:"settings.s3_test",ok:false,code:"S3_TEST_CLEANUP_FAILED"}));throw error;}finally{transport.destroy?.();}
  });

  app.get("/backups/status", async () => ({ ...backups.status(), protection: await backups.protection(), scheduleEnabled:scheduler.status().enabled, automation:scheduler.status(), jobs:jobs.list() }));
  app.get("/backups/observability",async(request)=>{
    const query=z.object({days:z.coerce.number().int().min(1).max(90).default(7),limit:z.coerce.number().int().min(1).max(200).default(50)}).parse(request.query);
    return jobs.report(query.days,query.limit);
  });
  app.get("/backup-jobs", async () => ({jobs:jobs.list()}));
  app.post("/backup-jobs/:id/retry", async (request,reply) => {
    const {id}=z.object({id:z.string().uuid()}).parse(request.params);
    return reply.code(202).send({job:await jobs.retry(id)});
  });
  app.get("/backups", async () => settingQueue.run(async()=>({ snapshots: await backups.listSummaries() })));
  app.post("/backups", async (request, reply) => {
    const body = z.object({
      reason: z.enum(["manual", "scheduled", "pre-restore"]).default("manual"),
    }).parse(request.body ?? {});
    return reply.code(202).send({ job: await jobs.create("backup",undefined,body.reason) });
  });
  app.post("/backups/:id/restore", async (request,reply) => {
    const { id } = z.object({ id: z.string().min(1).max(200) }).parse(request.params);
    const { confirm } = z.object({ confirm: z.string() }).parse(request.body);
    if (confirm !== id) throw new Error("RESTORE_CONFIRMATION_MISMATCH");
    // Restore retains the previous local directories for rollback.
    return reply.code(202).send({job:await jobs.create("restore",id)});
  });

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    noteStore: NoteStore;
    backupService: BackupService;
  }
}
