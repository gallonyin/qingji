import { mkdtemp, mkdir, readFile, rm, writeFile, rename, readdir, stat, utimes } from "node:fs/promises";
import os from "node:os";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { BackupService } from "../src/backup-service.js";

class MemoryS3 {
  readonly objects = new Map<string, Buffer>();
  blobUploads = 0;
  requests: {name:string;key?:string;prefix?:string}[]=[];
  downloadedBytes=0;

  async send(command: any): Promise<any> {
    const name = command.constructor.name;
    const input = command.input;
    this.requests.push({name,key:input.Key,prefix:input.Prefix});
    const etag=(key:string)=>createHash("md5").update(this.objects.get(key)!).digest("hex");
    if (name === "HeadObjectCommand") {
      if (!this.objects.has(input.Key)) {
        const error = new Error("not found") as Error & { name: string; $metadata: { httpStatusCode: number } };
        error.name = "NotFound";
        error.$metadata = { httpStatusCode: 404 };
        throw error;
      }
      return {};
    }
    if (name === "PutObjectCommand") {
      this.objects.set(input.Key, Buffer.from(input.Body));
      if (input.Key.includes("/blobs/")) this.blobUploads += 1;
      return {ETag:etag(input.Key)};
    }
    if (name === "GetObjectCommand") {
      const body = this.objects.get(input.Key);
      if (!body) throw new Error("missing object");
      if(input.IfNoneMatch===etag(input.Key))throw Object.assign(new Error("not modified"),{$metadata:{httpStatusCode:304}});
      this.downloadedBytes+=body.length;
      return { Body: body, ETag:etag(input.Key) };
    }
    if (name === "ListObjectsV2Command") {
      return {
        IsTruncated: false,
        Contents: [...this.objects.keys()]
          .filter((key) => key.startsWith(input.Prefix))
          .map((Key) => ({ Key, Size: this.objects.get(Key)!.length, ETag:etag(Key) })),
      };
    }
    if (name === "DeleteObjectsCommand") {
      for (const item of input.Delete.Objects) this.objects.delete(item.Key);
      return {};
    }
    throw new Error(`unsupported command: ${name}`);
  }
}

describe("S3 backup service", () => {
  let directory: string;
  let s3: MemoryS3;
  let restored: number;
  let service: BackupService;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "mynote-backup-"));
    await Promise.all([
      mkdir(path.join(directory, "notes"), { recursive: true }),
      mkdir(path.join(directory, "attachments", "note-1"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(directory, "notes", "note-1.md"), "first version"),
      writeFile(path.join(directory, "attachments", "note-1", "image.bin"), "attachment"),
    ]);
    s3 = new MemoryS3();
    restored = 0;
    service = new BackupService(
      directory,
      { enabled: true, bucket: "backup", prefix: "mynote", retention: 2, intervalHours: 24 },
      s3,
      async () => { restored += 1; },
    );
  });

  afterEach(async () => {
    vi.useRealTimers(); service.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("观测统计实际传输含清单，缓存命中不重复上传，恢复下载可计量", async () => {
    const first=await service.createSnapshot();
    const stats=service.status().telemetry!;
    expect(stats.s3PutBytes).toBe([...s3.objects.values()].reduce((n,b)=>n+b.length,0));
    expect(stats.s3Calls).toBe(s3.requests.length);
    expect(stats.operations.PutObject.calls).toBe(4);
    expect(stats.writeLockMs).toBeGreaterThan(0);
    expect(stats.durationMs).toBeGreaterThan(0);
    expect(service.status().metrics.logicalFiles).toBe(2);
    await service.createSnapshot();
    expect(service.status().telemetry!.s3PutBytes).toBe(0);
    expect(service.status().metrics.skipped).toBe(true);
    const downloaded=s3.downloadedBytes;
    await service.restore(first.id);
    expect(service.status().telemetry!.s3GetBytes).toBe(s3.downloadedBytes-downloaded);
    expect(service.status().telemetry!.s3GetBytes).toBeGreaterThan(0);
  });

  it("刚发布后列表短暂缺失时重新验证，持续不一致不清理",async()=>{
    const original=s3.send.bind(s3);let lag=1;
    s3.send=async(command:any)=>{
      const result=await original(command);
      if(command.constructor.name==='ListObjectsV2Command'&&command.input.Prefix==='mynote/snapshots/'&&s3.objects.has('mynote/latest.json')&&lag-->0)return {...result,Contents:[]};
      return result;
    };
    await service.createSnapshot();expect(service.status().cleanupError).toBeNull();
    lag=100;await writeFile(path.join(directory,'notes','note-1.md'),'changed');
    await service.createSnapshot();expect(service.status().cleanupError).toBe('S3_LATEST_CHANGED');
    expect([...s3.objects.keys()].filter(k=>k.includes('/snapshots/'))).toHaveLength(2);
  });

  it("进程在目录切换中退出，重启恢复完整旧库并保留中断的新文件", async () => {
    const rollback = path.join(directory, ".rollback-test");
    const staging = path.join(directory, ".restore-test");
    await mkdir(rollback); await mkdir(staging);
    await rename(path.join(directory, "notes"), path.join(rollback, "notes"));
    await mkdir(path.join(directory, "notes"));
    await writeFile(path.join(directory, "notes", "new.md"), "interrupted new data");
    await writeFile(path.join(directory, ".backup-protection.json"), JSON.stringify({phase:"switching",snapshotId:"test",rollback,staging}));
    expect(await BackupService.recoverInterruptedSwitch(directory)).toBe(true);
    expect(await readFile(path.join(directory,"notes","note-1.md"),"utf8")).toBe("first version");
    expect(await readFile(path.join(directory,"attachments","note-1","image.bin"),"utf8")).toBe("attachment");
    const preserved=(await readdir(directory)).find(name=>name.startsWith(".interrupted-notes-"))!;
    expect(await readFile(path.join(directory,preserved,"new.md"),"utf8")).toBe("interrupted new data");
    expect(await BackupService.recoverInterruptedSwitch(directory)).toBe(false);
  });

  it("无法确定旧库位置时拒绝猜测恢复", async () => {
    await writeFile(path.join(directory,".backup-protection.json"),JSON.stringify({phase:"switching",rollback:"/tmp/other",staging:"/tmp/other"}));
    await expect(BackupService.recoverInterruptedSwitch(directory)).rejects.toThrow("RESTORE_RECOVERY_REQUIRED");
    expect(await readFile(path.join(directory,"notes","note-1.md"),"utf8")).toBe("first version");
  });

  it("创建内容寻址增量快照并复用未变化对象", async () => {
    const first = await service.createSnapshot();
    expect(first.files).toHaveLength(2);
    expect(s3.blobUploads).toBe(2);

    await writeFile(path.join(directory, "notes", "note-1.md"), "second version");
    const second = await service.createSnapshot();

    expect(second.id).not.toBe(first.id);
    expect(s3.blobUploads).toBe(3);
    expect(await service.listSnapshots()).toHaveLength(2);
    expect(s3.objects.has("mynote/latest.json")).toBe(true);
  });

  it("并发备份对内容相同的文件只上传一次", async () => {
    await writeFile(path.join(directory, "notes", "copy.md"), "first version");
    const snapshot = await service.createSnapshot();
    expect(snapshot.files).toHaveLength(3);
    expect(s3.blobUploads).toBe(2);
    await service.restore(snapshot.id);
    expect(await readFile(path.join(directory, "notes", "copy.md"), "utf8")).toBe("first version");
  });

  it("按快照恢复 Markdown 和附件并校验内容", async () => {
    const snapshot = await service.createSnapshot();
    await writeFile(path.join(directory, "notes", "note-1.md"), "broken local data");
    await rm(path.join(directory, "attachments"), { recursive: true, force: true });
    await mkdir(path.join(directory, "attachments"), { recursive: true });

    const restoredSnapshot = await service.restore(snapshot.id);

    expect(restoredSnapshot.id).toBe(snapshot.id);
    expect(await readFile(path.join(directory, "notes", "note-1.md"), "utf8")).toBe("first version");
    expect(await readFile(path.join(directory, "attachments", "note-1", "image.bin"), "utf8")).toBe("attachment");
    expect(restored).toBe(1);
  });

  it("超过保留数量清理旧快照及独占对象，保留共享附件", async () => {
    const first = await service.createSnapshot();
    await writeFile(path.join(directory, "notes", "note-1.md"), "version 2");
    await service.createSnapshot();
    await writeFile(path.join(directory, "notes", "note-1.md"), "version 3");
    await service.createSnapshot();

    const snapshots = await service.listSnapshots();
    expect(snapshots).toHaveLength(2);
    expect(snapshots.some((snapshot) => snapshot.id === first.id)).toBe(false);
    expect(s3.objects.has(`mynote/snapshots/${first.id}.json`)).toBe(false);
    expect(s3.objects.has(`mynote/blobs/${first.files.find(f=>f.path.startsWith("notes/"))!.sha256}`)).toBe(false);
    expect(s3.objects.has(`mynote/blobs/${first.files.find(f=>f.path.startsWith("attachments/"))!.sha256}`)).toBe(true);
    for (const snapshot of snapshots) await service.restore(snapshot.id);
  });
  it("空库和容量骤降均拒绝发布且不清理任何对象", async () => {
    await service.createSnapshot();
    const keys = [...s3.objects.keys()];
    await writeFile(path.join(directory, "notes", "note-1.md"), "x");
    await expect(service.createSnapshot("scheduled")).rejects.toThrow("BACKUP_ABNORMAL_DROP");
    await rm(path.join(directory, "notes", "note-1.md"));
    await expect(service.createSnapshot()).rejects.toThrow("BACKUP_ABNORMAL_DROP");
    expect([...s3.objects.keys()]).toEqual(keys);
  });

  it("损坏对象恢复失败，原数据不变，重启后仍禁止备份和写入", async () => {
    const snap = await service.createSnapshot();
    const key = `mynote/blobs/${snap.files[0].sha256}`;
    const original = s3.objects.get(key)!;
    s3.objects.set(key, Buffer.from("corrupted"));
    await expect(service.restore(snap.id)).rejects.toThrow("BACKUP_CHECKSUM_MISMATCH");
    expect(await readFile(path.join(directory, "notes", "note-1.md"), "utf8")).toBe("first version");
    const restarted = new BackupService(directory, service.config, s3, async () => {});
    await expect(restarted.createSnapshot()).rejects.toThrow("BACKUP_PROTECTED");
    await expect(restarted.assertWritable()).rejects.toThrow("BACKUP_PROTECTED");
    s3.objects.set(key, original);
    await restarted.restore(snap.id);
    expect(await restarted.protection()).toBeNull();
  });

  it("切换中断要求人工恢复，不重新覆盖现场", async () => {
    const snap = await service.createSnapshot();
    await writeFile(path.join(directory, ".backup-protection.json"), JSON.stringify({phase: "switching"}));
    await expect(service.restore(snap.id)).rejects.toThrow("RESTORE_RECOVERY_REQUIRED");
    await expect(service.createSnapshot()).rejects.toThrow("BACKUP_PROTECTED");
  });

  it("索引失败回滚原文件并保留保护状态", async () => {
    const snap = await service.createSnapshot();
    await writeFile(path.join(directory, "notes", "note-1.md"), "local change");
    let calls = 0;
    const failing = new BackupService(directory, service.config, s3, async () => {
      if (++calls === 1) throw new Error("INDEX_FAILED");
    });
    await expect(failing.restore(snap.id)).rejects.toThrow("INDEX_FAILED");
    expect(await readFile(path.join(directory, "notes", "note-1.md"), "utf8")).toBe("local change");
    await expect(failing.assertWritable()).rejects.toThrow("BACKUP_PROTECTED");
  });

  it("拒绝快照路径穿越且不改正式数据", async () => {
    const snap = await service.createSnapshot();
    snap.files[0].path = "notes/../outside";
    s3.objects.set(`mynote/snapshots/${snap.id}.json`, Buffer.from(JSON.stringify(snap)));
    await expect(service.restore(snap.id)).rejects.toThrow("INVALID_BACKUP_MANIFEST");
    expect(await readFile(path.join(directory, "notes", "note-1.md"), "utf8")).toBe("first version");
  });

  it("下载中断重启后复用已校验文件", async () => {
    const old = process.env.S3_BACKUP_CONCURRENCY;
    process.env.S3_BACKUP_CONCURRENCY = "1";
    try {
      const snap = await service.createSnapshot();
      const first = `mynote/blobs/${snap.files[0].sha256}`;
      const second = `mynote/blobs/${snap.files[1].sha256}`;
      const original = s3.send.bind(s3);
      let fail = true, firstReads = 0;
      s3.send = async (command: any) => {
        if (command.constructor.name === "GetObjectCommand") {
          if (command.input.Key === first) firstReads++;
          if (command.input.Key === second && fail) throw new Error("injected permanent failure");
        }
        return original(command);
      };
      await expect(service.restore(snap.id)).rejects.toThrow("injected permanent failure");
      expect(firstReads).toBe(1);
      fail = false;
      const restarted = new BackupService(directory, service.config, s3, async () => {});
      await restarted.restore(snap.id);
      expect(firstReads).toBe(1);
      expect(await restarted.protection()).toBeNull();
    } finally {
      if (old === undefined) delete process.env.S3_BACKUP_CONCURRENCY;
      else process.env.S3_BACKUP_CONCURRENCY = old;
    }
  });

  it("响应体 aborted 会重试完整对象读取", async () => {
    const snap = await service.createSnapshot();
    const original = s3.send.bind(s3);
    let failures = 0;
    s3.send = async (command: any) => {
      if (command.constructor.name === "GetObjectCommand" && command.input.Key.includes("/blobs/") && failures++ === 0) {
        return { Body: { transformToByteArray: async () => { throw new Error("aborted"); } } };
      }
      return original(command);
    };
    await service.restore(snap.id);
    expect(failures).toBe(3);
    expect(await service.protection()).toBeNull();
  });

  it("上传被阻塞时仍可通过 API 修改和删除，快照保留修改前正文和同名附件", async () => {
    const root = path.join(directory, "live");
    const backup = new BackupService(root, service.config, s3, async () => {});
    const app = await buildApp({dataDir:root,password:"test",backupService:backup});
    let release!: () => void;
    const blocked = new Promise<void>(r => release = r);
    let entered!: () => void;
    const uploading = new Promise<void>(r => entered = r);
    const original = s3.send.bind(s3);
    s3.send = async (command:any) => {
      if (command.constructor.name === "PutObjectCommand" && command.input.Key.includes("/blobs/")) { entered(); await blocked; }
      return original(command);
    };
    try {
      const login = (await app.inject({method:"POST",url:"/auth/login",payload:{password:"test"}})).json();
      const headers = {authorization:`Bearer ${login.token}`,"x-vault-epoch":login.epoch};
      const note = (await app.inject({method:"POST",url:"/notes",headers,payload:{title:"before",content:"before content"}})).json().note;
      await app.noteStore.saveAttachment(note.id,"same.bin",Buffer.from("old attachment"));
      expect((await app.inject({method:"POST",url:"/backups",headers,payload:{}})).statusCode).toBe(202);
      await uploading;
      const update = await app.inject({method:"PATCH",url:`/notes/${note.id}`,headers,payload:{revision:1,content:"after content"}});
      expect(update.statusCode).toBe(200);
      await app.noteStore.saveAttachment(note.id,"same.bin",Buffer.from("new attachment"));
      expect((await app.noteStore.readAttachment(note.id,"same.bin")).toString()).toBe("new attachment");
      expect((await app.inject({method:"DELETE",url:`/notes/${note.id}?revision=2`,headers})).statusCode).toBe(200);
      release();
      await app.close();
      const manifest = (await backup.listSnapshots())[0];
      const content = s3.objects.get(`mynote/blobs/${manifest.files.find(f=>f.path.startsWith("notes/"))!.sha256}`)!.toString();
      expect(content).toContain("before content");expect(content).not.toContain("after content");
      expect(s3.objects.get(`mynote/blobs/${manifest.files.find(f=>f.path.startsWith("attachments/"))!.sha256}`)!.toString()).toBe("old attachment");
      expect((await readdir(root)).includes(".backup-capture")).toBe(false);
    } finally { release(); await app.close(); }
  });

  it("保护快照、共享对象、其他目录不清理，普通快照仅保留指定数量", async () => {
    const protectedSnapshot = await service.createSnapshot("pre-restore");
    s3.objects.set("other/blobs/"+"a".repeat(64),Buffer.from("unrelated"));
    for(let i=0;i<4;i++) {
      await writeFile(path.join(directory,"notes","note-1.md"),`normal version ${i}`);
      await service.createSnapshot(i%2 ? "manual":"scheduled");
    }
    const snapshots=await service.listSnapshots();
    expect(snapshots).toHaveLength(3);
    expect(snapshots.some(s=>s.id===protectedSnapshot.id)).toBe(true);
    expect(snapshots.filter(s=>!s.protected)).toHaveLength(2);
    expect(s3.objects.has("other/blobs/"+"a".repeat(64))).toBe(true);
    for(const snapshot of snapshots)await service.restore(snapshot.id);
  });

  it("清理部分失败保留已发布备份，不删除仍被快照引用的对象，下次补清理", async () => {
    const first=await service.createSnapshot();
    await writeFile(path.join(directory,"notes","note-1.md"),"second version");await service.createSnapshot();
    const original=s3.send.bind(s3);
    s3.send=async(command:any)=>command.constructor.name==="DeleteObjectsCommand"?{Errors:[{Code:"AccessDenied"}]}:original(command);
    await writeFile(path.join(directory,"notes","note-1.md"),"third version");
    const latest=await service.createSnapshot();
    expect(service.status().cleanupError).toBe("S3_CLEANUP_PARTIAL_FAILURE");
    expect(JSON.parse(s3.objects.get("mynote/latest.json")!.toString()).id).toBe(latest.id);
    for(const file of first.files)expect(s3.objects.has(`mynote/blobs/${file.sha256}`)).toBe(true);
    s3.send=original;await service.createSnapshot();
    expect(service.status().cleanupError).toBeNull();expect(await service.listSnapshots()).toHaveLength(2);
  });

  it("发布 latest 失败不执行清理，重试复用已上传对象", async () => {
    await service.createSnapshot();
    await writeFile(path.join(directory,"notes","note-1.md"),"second version");await service.createSnapshot();
    const keys=[...s3.objects.keys()];const original=s3.send.bind(s3);
    s3.send=async(command:any)=>{if(command.constructor.name==="PutObjectCommand"&&command.input.Key==="mynote/latest.json")throw new Error("PUBLISH_FAILED");return original(command);};
    await writeFile(path.join(directory,"notes","note-1.md"),"third version");
    await expect(service.createSnapshot()).rejects.toThrow("PUBLISH_FAILED");
    for(const key of keys)expect(s3.objects.has(key)).toBe(true);
    const count=s3.blobUploads;s3.send=original;await service.createSnapshot();expect(s3.blobUploads).toBe(count);
  });

  it("清单损坏时拒绝备份和清理，批量清单查询复用对象且不发 HEAD", async () => {
    const first=await service.createSnapshot();const original=s3.send.bind(s3);
    s3.send=async(command:any)=>{if(command.constructor.name==="HeadObjectCommand")throw new Error("UNEXPECTED_HEAD");return original(command);};
    await service.createSnapshot();expect(s3.blobUploads).toBe(2);
    s3.objects.set(`mynote/snapshots/${first.id}.json`,Buffer.from('{"version":1,"id":"bad","files":[]}'));
    const keys=[...s3.objects.keys()];await expect(service.createSnapshot()).rejects.toThrow("INVALID_BACKUP_MANIFEST");expect([...s3.objects.keys()]).toEqual(keys);
  });

  it("重启后无变化不读正文、不列举 blobs、不重新上传和下载清单", async () => {
    const first=await service.createSnapshot();service.close();
    service=new BackupService(directory,service.config,s3,async()=>{});
    const start=s3.requests.length,bytes=s3.downloadedBytes;
    const second=await service.createSnapshot();
    expect(second.id).toBe(first.id);
    expect(service.status().metrics).toMatchObject({hashedFiles:0,hashedBytes:0,reusedHashes:2,uploadedFiles:0,skipped:true,fullCheck:false});
    const requests=s3.requests.slice(start);
    expect(requests.some(r=>r.prefix==="mynote/blobs/")).toBe(false);
    expect(requests.some(r=>r.name==="PutObjectCommand")).toBe(false);
    expect(s3.downloadedBytes).toBe(bytes);
  });

  it("只重新计算原子替换的文件；大小及修改时间相同也不会误复用", async () => {
    const first=await service.createSnapshot();
    const original=path.join(directory,"notes","note-1.md"), temporary=path.join(directory,"changed.tmp");
    const before=await stat(original);
    await writeFile(temporary,"other version");await utimes(temporary,before.atime,before.mtime);await rename(temporary,original);
    const second=await service.createSnapshot();
    expect(second.id).not.toBe(first.id);
    expect(service.status().metrics).toMatchObject({hashedFiles:1,reusedHashes:1,uploadedFiles:1,skipped:false});
    await service.restore(second.id);expect(await readFile(original,"utf8")).toBe("other version");
  });

  it("上传中断后重启复用成功对象，失败对象没有被缓存为已上传", async () => {
    const original=s3.send.bind(s3);
    s3.send=async(command:any)=>{
      if(command.constructor.name==="PutObjectCommand" && command.input.Key.includes("/blobs/") && Buffer.from(command.input.Body).toString()==="first version")throw new Error("UPLOAD_FAILED");
      return original(command);
    };
    await expect(service.createSnapshot()).rejects.toThrow("UPLOAD_FAILED");
    expect(s3.blobUploads).toBe(1);service.close();
    s3.send=original;service=new BackupService(directory,service.config,s3,async()=>{});
    await service.createSnapshot();expect(s3.blobUploads).toBe(2);
    expect(service.status().metrics).toMatchObject({hashedFiles:0,uploadedFiles:1});
  });

  it("全量核对到期重新计算哈希、列举远端并修复缺失对象，不创建重复快照", async () => {
    const first=await service.createSnapshot();
    const missing=`mynote/blobs/${first.files[0].sha256}`;s3.objects.delete(missing);
    vi.setSystemTime(Date.now()+8*24*3600_000);
    const start=s3.requests.length;const second=await service.createSnapshot();
    expect(second.id).toBe(first.id);expect(s3.objects.has(missing)).toBe(true);
    expect(service.status().metrics).toMatchObject({hashedFiles:2,uploadedFiles:1,skipped:true,fullCheck:true});
    expect(s3.requests.slice(start).filter(r=>r.prefix==="mynote/blobs/")).toHaveLength(1);
  });

  it("缓存按目标隔离，切换前缀仍完整检查并上传", async () => {
    await service.createSnapshot();service.close();
    service=new BackupService(directory,{...service.config,prefix:"other-vault"},s3,async()=>{});
    await service.createSnapshot();expect(s3.blobUploads).toBe(4);
    expect(service.status().metrics.fullCheck).toBe(true);
  });

  it("新清单 gzip 压缩且 latest 为小指针，旧明文清单仍可读取恢复", async () => {
    const first=await service.createSnapshot();
    const key=`mynote/snapshots/${first.id}.json`;
    const compressed=s3.objects.get(key)!;expect(compressed[0]).toBe(0x1f);
    expect(JSON.parse(gunzipSync(compressed).toString()).files).toEqual(first.files);
    const latest=JSON.parse(s3.objects.get("mynote/latest.json")!.toString());expect(latest.version).toBe(2);expect(latest.files).toBeUndefined();
    s3.objects.set(key,Buffer.from(JSON.stringify(first)));s3.objects.set("mynote/latest.json",Buffer.from(JSON.stringify(first)));
    expect((await service.createSnapshot()).id).toBe(first.id);
    await service.restore(first.id);expect(await readFile(path.join(directory,"notes","note-1.md"),"utf8")).toBe("first version");
    const summaries=await service.listSummaries();expect(summaries[0]).toMatchObject({fileCount:2});expect(summaries[0]).not.toHaveProperty("files");
    expect(service.status().lastBackup).not.toHaveProperty("files");
  });

  it("清理删除的对象必须失效缓存，重新出现的旧正文会重新上传", async () => {
    await service.createSnapshot();await writeFile(path.join(directory,"notes","note-1.md"),"second version");await service.createSnapshot();
    await writeFile(path.join(directory,"notes","note-1.md"),"third version");await service.createSnapshot();
    const count=s3.blobUploads;await writeFile(path.join(directory,"notes","note-1.md"),"first version");const snap=await service.createSnapshot();
    expect(s3.blobUploads).toBe(count+1);await service.restore(snap.id);
  });

});
