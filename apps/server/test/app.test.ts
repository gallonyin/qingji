import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("mynote server", () => {
  let app: FastifyInstance;
  let directory: string;
  let authorization: string;
  let epoch: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "mynote-"));
    app = await buildApp({ dataDir: directory, password: "test-password" });
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { password: "test-password" },
    });
    authorization = `Bearer ${response.json().token}`;
    epoch = response.json().epoch;
  });

  afterEach(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function create(title: string, content = "", folder = "") {
    const response = await app.inject({
      method: "POST",
      url: "/notes",
      headers: { authorization, "x-vault-epoch": epoch },
      payload: { title, content, folder, tags: ["测试"] },
    });
    expect(response.statusCode).toBe(201);
    return response.json().note;
  }

  it("搜索摘要不传正文，全文匹配保持且可按 ID 读取完整正文",async()=>{
    const content="长正文".repeat(1000)+"uniqueSearchNeedle";
    const note=await create("摘要测试",content);
    const result=await app.inject({url:"/search?q=uniqueSearchNeedle&summary=1",headers:{authorization}});
    expect(result.statusCode).toBe(200);expect(result.json().results).toHaveLength(1);
    expect(result.json().results[0]).not.toHaveProperty("content");
    expect(result.json().results[0].excerpt.length).toBeLessThanOrEqual(72);
    expect((await app.inject({url:`/notes/${note.id}`,headers:{authorization}})).json().note.content).toBe(content);
    expect((await app.inject({url:"/search?q=uniqueSearchNeedle",headers:{authorization}})).json().results[0].content).toBe(content);
  });

  it("空同步和失败修改不重置自动备份计时，正文与附件变更均被记录", async () => {
    const status=async()=>(await app.inject({url:"/backups/status",headers:{authorization}})).json().automation;
    const before=await status();
    await app.inject({method:"POST",url:"/sync/push",headers:{authorization,"x-vault-epoch":epoch},payload:{changes:[]}});
    expect((await status()).pendingChanges).toBe(before.pendingChanges);
    const note=await create("自动备份触发","正文");const created=await status();expect(created.pendingChanges).toBe(before.pendingChanges+1);
    await app.inject({method:"PATCH",url:`/notes/${note.id}`,headers:{authorization,"x-vault-epoch":epoch},payload:{revision:999,content:"冲突"}});
    expect((await status()).pendingChanges).toBe(created.pendingChanges);
    await app.noteStore.saveAttachment(note.id,"attachment.bin",Buffer.from("data"));expect((await status()).pendingChanges).toBe(created.pendingChanges+1);
  });

  it("非法路径请求不会留下阻止下次启动的待重放操作", async () => {
    const response = await app.inject({method:"POST",url:"/sync/push",headers:{authorization,"x-vault-epoch":epoch},payload:{changes:[{id:crypto.randomUUID(),operationId:crypto.randomUUID(),baseRevision:0,title:"invalid",folder:"../escape"}]}});
    expect(response.statusCode).toBe(400);
    await app.close();
    app = await buildApp({dataDir:directory,password:"test-password"});
    expect((await app.inject({method:"GET",url:"/health"})).statusCode).toBe(200);
  });

  it("同步历史检查点和重启均保留正文首尾换行", async () => {
    const content = "\n\n正文\n\n";
    const note = await create("空白保真",content);
    const state = (await app.inject({url:"/sync/state",headers:{authorization}})).json();
    await app.inject({method:"PATCH",url:`/notes/${note.id}`,headers:{authorization,"x-vault-epoch":epoch},payload:{revision:1,content:"后续正文"}});
    const page = (await app.inject({url:`/sync/pull?until=${state.cursor}`,headers:{authorization}})).json();
    expect(page.changes.find((c:any)=>c.noteId===note.id).note.content).toBe(content);
    const second = await create("重启保真",content);
    await app.close();app=await buildApp({dataDir:directory,password:"test-password"});
    expect((await app.inject({url:`/notes/${second.id}`,headers:{authorization}})).json().note.content).toBe(content);
  });

  it("支持认证、CRUD、目录和稳定 frontmatter", async () => {
    expect((await app.inject({ method: "GET", url: "/notes" })).statusCode).toBe(401);
    const created = await create("第一篇", "正文", "工作/计划");
    const updated = await app.inject({
      method: "PATCH",
      url: `/notes/${created.id}`,
      headers: { authorization, "x-vault-epoch": epoch },
      payload: { revision: 1, title: "更新后", favorite: true },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().note).toMatchObject({ id: created.id, revision: 2, folder: "工作/计划", favorite: true });

    const markdown = await readFile(path.join(directory, "notes", "工作", "计划", `${created.id}.md`), "utf8");
    expect(markdown).toContain(`id: ${created.id}`);
    expect(markdown).toContain("revision: 2");
    expect(markdown).toContain("createdAt:");
  });

  it("对中文标题、正文、标签和路径进行 substring 搜索并高亮", async () => {
    await create("项目会议", "讨论离线同步方案", "客户/上海");
    const response = await app.inject({
      method: "GET",
      url: "/search?q=离线同步",
      headers: { authorization, "x-vault-epoch": epoch },
    });
    expect(response.json().results).toHaveLength(1);
    expect(response.json().results[0].highlights.join("")).toContain("<mark>离线同步</mark>");
  });

  it("支持离线增量 pull/push 和单调全局 sequence", async () => {
    const initial = await app.inject({
      method: "POST",
      url: "/sync/push",
      headers: { authorization, "x-vault-epoch": epoch },
      payload: { changes: [{ id: crypto.randomUUID(), baseRevision: 0, title: "离线新建", content: "v1" }] },
    });
    const cursor = initial.json().cursor;
    expect(cursor).toBeGreaterThan(0);
    const note = initial.json().results[0].note;

    await app.inject({
      method: "POST",
      url: "/sync/push",
      headers: { authorization, "x-vault-epoch": epoch },
      payload: { changes: [{ id: note.id, baseRevision: 1, title: note.title, content: "v2" }] },
    });
    const pull = await app.inject({
      method: "GET",
      url: `/sync/pull?since=${cursor}`,
      headers: { authorization, "x-vault-epoch": epoch },
    });
    expect(pull.json().changes).toHaveLength(1);
    expect(pull.json().changes[0].sequence).toBeGreaterThan(cursor);
    expect(pull.json().changes[0].note.content).toBe("v2");
  });

  it("使用 operationId 对网络重试进行幂等去重", async () => {
    const operationId = crypto.randomUUID();
    const id = crypto.randomUUID();
    const payload = {
      changes: [{ operationId, id, baseRevision: 0, title: "仅创建一次", content: "正文" }],
    };
    const first = await app.inject({
      method: "POST",
      url: "/sync/push",
      headers: { authorization, "x-vault-epoch": epoch },
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/sync/push",
      headers: { authorization, "x-vault-epoch": epoch },
      payload,
    });
    expect(second.json()).toEqual(first.json());

    const pull = await app.inject({
      method: "GET",
      url: "/sync/pull?since=0",
      headers: { authorization, "x-vault-epoch": epoch },
    });
    expect(pull.json().changes).toHaveLength(1);
  });

  it("revision 冲突时保留服务端版本并创建冲突副本", async () => {
    const note = await create("原笔记", "server v1");
    await app.inject({
      method: "PATCH",
      url: `/notes/${note.id}`,
      headers: { authorization, "x-vault-epoch": epoch },
      payload: { revision: 1, content: "server v2" },
    });
    const response = await app.inject({
      method: "POST",
      url: "/sync/push",
      headers: { authorization, "x-vault-epoch": epoch },
      payload: { changes: [{ id: note.id, baseRevision: 1, title: "原笔记", content: "offline v2" }] },
    });
    expect(response.json().results[0].conflict).toBe(true);
    expect(response.json().results[0].note.id).not.toBe(note.id);
    const original = await app.inject({ method: "GET", url: `/notes/${note.id}`, headers: { authorization, "x-vault-epoch": epoch } });
    expect(original.json().note.content).toBe("server v2");
    expect(response.json().results[0].note.content).toBe("offline v2");
  });

  it("支持删除、回收站和恢复", async () => {
    const note = await create("待删除");
    const deleted = await app.inject({
      method: "DELETE",
      url: `/notes/${note.id}?revision=1`,
      headers: { authorization, "x-vault-epoch": epoch },
    });
    expect(deleted.json().note.deletedAt).toBeTruthy();
    const trash = await app.inject({ method: "GET", url: "/notes?view=trash", headers: { authorization, "x-vault-epoch": epoch } });
    expect(trash.json().notes.map((item: { id: string }) => item.id)).toContain(note.id);

    const restored = await app.inject({
      method: "POST",
      url: `/notes/${note.id}/restore`,
      headers: { authorization, "x-vault-epoch": epoch },
      payload: { revision: 2 },
    });
    expect(restored.json().note).toMatchObject({ revision: 3, deletedAt: null });
  });

  it("离线同步协议可恢复已删除笔记", async () => {
    const note = await create("离线恢复");
    await app.inject({
      method: "POST",
      url: "/sync/push",
      headers: { authorization, "x-vault-epoch": epoch },
      payload: { changes: [{ id: note.id, baseRevision: 1, deleted: true }] },
    });
    const restored = await app.inject({
      method: "POST",
      url: "/sync/push",
      headers: { authorization, "x-vault-epoch": epoch },
      payload: { changes: [{ id: note.id, baseRevision: 2, restored: true }] },
    });
    expect(restored.json().results[0].note).toMatchObject({
      revision: 3,
      deletedAt: null,
    });
  });

  it("回收站笔记可以永久删除并向其他客户端发送墓碑", async () => {
    const note = await create("永久删除测试");
    await app.inject({
      method: "DELETE",
      url: `/notes/${note.id}?revision=1`,
      headers: { authorization, "x-vault-epoch": epoch },
    });
    const purged = await app.inject({
      method: "DELETE",
      url: `/notes/${note.id}/permanent?revision=2`,
      headers: { authorization, "x-vault-epoch": epoch },
    });
    expect(purged.statusCode).toBe(200);

    const fetched = await app.inject({
      method: "GET",
      url: `/notes/${note.id}`,
      headers: { authorization, "x-vault-epoch": epoch },
    });
    expect(fetched.statusCode).toBe(404);

    const pull = await app.inject({
      method: "GET",
      url: "/sync/pull?since=1",
      headers: { authorization, "x-vault-epoch": epoch },
    });
    expect(pull.json().changes.at(-1)).toMatchObject({
      noteId: note.id,
      kind: "purge",
      note: null,
    });
  });

  it("附件可从受认证的 API 下载", async () => {
    const note = await create("附件测试");
    const attachment = await app.noteStore.saveAttachment(note.id, "示意.png", Buffer.from("image-bytes"));
    const response = await app.inject({
      method: "GET",
      url: attachment.path.replace(/^\/api/, ""),
      headers: { authorization, "x-vault-epoch": epoch },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.rawPayload).toEqual(Buffer.from("image-bytes"));
  });

  it("未配置 S3 时明确报告备份状态而不影响笔记服务", async () => {
    const status = await app.inject({
      method: "GET",
      url: "/backups/status",
      headers: { authorization, "x-vault-epoch": epoch },
    });
    expect(status.json()).toMatchObject({ configured: false, running: false });

    const backup = await app.inject({
      method: "POST",
      url: "/backups",
      headers: { authorization, "x-vault-epoch": epoch },
      payload: {},
    });
    expect(backup).toMatchObject({ statusCode: 503 });
    expect(backup.json()).toEqual({ error: "S3_BACKUP_NOT_CONFIGURED" });
  });

  it("手动重扫可从 Markdown 重建索引和同步事件", async () => {
    const note = await create("扫描前", "内容");
    const filename = path.join(directory, "notes", `${note.id}.md`);
    const markdown = (await readFile(filename, "utf8")).replace("扫描前", "磁盘修改");
    await writeFile(filename, markdown);
    const scan = await app.inject({ method: "POST", url: "/scan", headers: { authorization, "x-vault-epoch": epoch } });
    expect(scan.json()).toMatchObject({ scanned: 1, errors: [] });
    const fetched = await app.inject({ method: "GET", url: `/notes/${note.id}`, headers: { authorization, "x-vault-epoch": epoch } });
    expect(fetched.json().note.title).toBe("磁盘修改");
    epoch = (await app.inject({url:"/sync/state",headers:{authorization}})).json().epoch;
    const pull = await app.inject({ method: "GET", url: "/sync/pull?since=0", headers: { authorization, "x-vault-epoch": epoch } });
    expect(pull.json().changes).toHaveLength(1);
  });

  it("仅凭数据目录即可在新服务实例恢复笔记", async () => {
    const note = await create("备份恢复", "文件才是真相源", "归档");
    await app.close();

    app = await buildApp({ dataDir: directory, password: "test-password" });
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { password: "test-password" },
    });
    authorization = `Bearer ${login.json().token}`;
    epoch = login.json().epoch;
    const restored = await app.inject({
      method: "GET",
      url: `/notes/${note.id}`,
      headers: { authorization, "x-vault-epoch": epoch },
    });
    expect(restored.json().note).toMatchObject({
      title: "备份恢复",
      content: "文件才是真相源",
      folder: "归档",
    });
  });
  it("恢复保护状态阻止同步写入，保留读取并通过状态接口展示", async () => {
    await writeFile(path.join(directory, ".backup-protection.json"), JSON.stringify({phase: "downloading", snapshotId: "test"}));
    for (const url of ["/notes", "/sync/push"]) {
      const result = await app.inject({method: "POST", url, headers: {authorization, "x-vault-epoch": epoch}, payload: {}});
      expect(result.statusCode).toBe(409);
      expect(result.json().error).toBe("BACKUP_PROTECTED");
    }
    expect((await app.inject({url: "/notes", headers: {authorization, "x-vault-epoch": epoch}})).statusCode).toBe(200);
    const status = await app.inject({url: "/backups/status", headers: {authorization, "x-vault-epoch": epoch}});
    expect(status.json().protection.phase).toBe("downloading");
  });

  it("切换中断时服务启动拒绝扫描不完整目录", async () => {
    await app.close();
    await writeFile(path.join(directory, ".backup-protection.json"), JSON.stringify({phase: "switching"}));
    await expect(buildApp({dataDir: directory, password: "test-password"})).rejects.toThrow("RESTORE_RECOVERY_REQUIRED");
  });

  it("两个浏览器同时编辑同一版本，只接受一个原笔记更新", async () => {
    const note=await create("并发", "初始");
    const send=(content:string)=>app.inject({method:"POST",url:"/sync/push",headers:{authorization,"x-vault-epoch":epoch},payload:{changes:[{id:note.id,operationId:crypto.randomUUID(),baseRevision:1,content}]}});
    const responses=await Promise.all([send("电脑A"),send("电脑B")]);
    expect(responses.map(r=>r.statusCode)).toEqual([200,200]);
    expect(responses.map(r=>r.json().results[0].conflict).sort()).toEqual([false,true]);
    const notes=(await app.inject({url:"/notes",headers:{authorization}})).json().notes;
    expect(notes.map((n:any)=>n.content).sort()).toEqual(["电脑A","电脑B"]);
  });

  it("同时重发操作只提交一次，复用ID但修改内容被拒绝", async () => {
    const change={id:crypto.randomUUID(),operationId:crypto.randomUUID(),baseRevision:0,title:"重复"};
    const send=(c:any)=>app.inject({method:"POST",url:"/sync/push",headers:{authorization,"x-vault-epoch":epoch},payload:{changes:[c]}});
    const [a,b]=await Promise.all([send(change),send(change)]);
    expect(a.json()).toEqual(b.json());
    expect((await send({...change,title:"篡改同一操作"})).statusCode).toBe(409);
    const notes=(await app.inject({url:"/notes",headers:{authorization}})).json().notes;
    expect(notes).toHaveLength(1);
  });

  it("恢复世代变化后先拒绝旧推送，而非命中旧操作缓存", async () => {
    await create("原笔记");
    await app.inject({method:"POST",url:"/scan",headers:{authorization,"x-vault-epoch":epoch}});
    const result=await app.inject({method:"POST",url:"/sync/push",headers:{authorization,"x-vault-epoch":epoch},payload:{changes:[]}});
    expect(result.statusCode).toBe(409);expect(result.json().error).toBe("EPOCH_CHANGED");
  });

  it("分页返回检查点时的版本，后续编辑不会混进旧事件", async () => {
    const note=await create("版本一");
    const state=(await app.inject({url:"/sync/state",headers:{authorization}})).json();
    await app.inject({method:"PATCH",url:`/notes/${note.id}`,headers:{authorization,"x-vault-epoch":epoch},payload:{revision:1,title:"版本二"}});
    const page=(await app.inject({url:`/sync/pull?since=0&until=${state.cursor}`,headers:{authorization,"x-vault-epoch":epoch}})).json();
    expect(page.changes[0].note.title).toBe("版本一");
    expect(page.hasMore).toBe(false);
  });

});
