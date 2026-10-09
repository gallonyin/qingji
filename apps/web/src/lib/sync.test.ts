import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNote, db, updateNote, type Note } from "./db";
import { resolveConflict, syncNow, type SyncTransport } from "./sync";

describe("同步行为", () => {
  beforeEach(async () => {
    Object.defineProperty(window.navigator, "onLine", { value: true, configurable: true });
    await db.notes.clear();
    await db.outbox.clear();
    await db.conflicts.clear();
    await db.meta.clear();
    await db.recoveryDrafts.clear();
  });

  it("推送成功后清理 outbox 并保存游标", async () => {
    const note = await createNote();
    const transport: SyncTransport = {
      push: vi.fn().mockResolvedValue({ ok: true }),
      pull: vi.fn().mockResolvedValue({ notes: [], cursor: "cursor-2" })
    };

    await syncNow(transport);

    expect(transport.push).toHaveBeenCalled();
    expect(await db.outbox.count()).toBe(0);
    expect((await db.meta.get("syncCursor"))?.value).toBe("cursor-2");
    expect(await db.notes.get(note.id)).toBeTruthy();
  });

  it("断网时保留 outbox，恢复网络后再发送", async () => {
    Object.defineProperty(window.navigator, "onLine", { value: false, configurable: true });
    await createNote();
    const transport: SyncTransport = {
      push: vi.fn().mockResolvedValue({ ok: true }),
      pull: vi.fn().mockResolvedValue({ notes: [], cursor: "1" })
    };

    await syncNow(transport);
    expect(transport.push).not.toHaveBeenCalled();
    expect(await db.outbox.count()).toBe(1);

    Object.defineProperty(window.navigator, "onLine", { value: true, configurable: true });
    await syncNow(transport);
    expect(transport.push).toHaveBeenCalledTimes(1);
    expect(await db.outbox.count()).toBe(0);
  });

  it("服务端冲突可见且不会覆盖本地内容", async () => {
    const note = await createNote();
    const local = await updateNote(note.id, { content: "本机版本" });
    const remote: Note = {
      ...local,
      content: "服务端版本",
      version: 2
    };
    const conflictCopy: Note = {
      ...local,
      id: crypto.randomUUID(),
      title: `${local.title}（冲突副本）`,
      version: 1
    };
    const transport: SyncTransport = {
      push: vi.fn().mockResolvedValue({ ok: false, conflict: remote, conflictCopy }),
      pull: vi.fn().mockResolvedValue({ notes: [], cursor: "next" })
    };

    await syncNow(transport);

    expect((await db.notes.get(note.id))?.content).toBe("本机版本");
    expect((await db.notes.get(conflictCopy.id))?.content).toBe("本机版本");
    expect(await db.conflicts.where("entityId").equals(note.id).count()).toBeGreaterThan(0);
    expect(await db.outbox.where("entityId").equals(note.id).count()).toBe(0);
  });

  it("采用远端版本时显式清理本地待推送项", async () => {
    const local = await createNote();
    const remote = { ...local, content: "远端最终稿", version: 8 };
    const id = await db.conflicts.add({ entityId: local.id, local, remote, createdAt: Date.now() });

    await resolveConflict(id!, "remote");

    expect((await db.notes.get(local.id))?.content).toBe("远端最终稿");
    expect(await db.outbox.where("entityId").equals(local.id).count()).toBe(0);
    expect(await db.conflicts.count()).toBe(0);
  });

  it("其他客户端永久删除后会应用墓碑并清除本地缓存", async () => {
    const note = await createNote();
    await db.outbox.clear();
    const transport: SyncTransport = {
      push: vi.fn().mockResolvedValue({ ok: true }),
      pull: vi.fn().mockResolvedValue({ notes: [], deletedIds: [note.id], cursor: "purged" })
    };

    await syncNow(transport);

    expect(await db.notes.get(note.id)).toBeUndefined();
    expect((await db.meta.get("syncCursor"))?.value).toBe("purged");
  });
  it("首次同步立即拉完分页", async () => {
    const pull=vi.fn().mockResolvedValueOnce({notes:[],cursor:"1",hasMore:true,until:2}).mockResolvedValueOnce({notes:[],cursor:"2",hasMore:false,until:2});
    await syncNow({push:vi.fn(),pull});
    expect(pull).toHaveBeenCalledTimes(2);
    expect(pull.mock.calls[1]).toEqual(["1",2]);
    expect((await db.meta.get("syncCursor"))?.value).toBe("2");
  });

  it("等待服务器响应时继续输入，不被旧响应覆盖", async () => {
    const note=await createNote();
    const transport:SyncTransport={push:async()=>{
      await updateNote(note.id,{content:"响应回来前的新输入"});
      return {ok:true,note:{...note,version:1,serverVersion:1}};
    },pull:async()=>({notes:[],cursor:"1"})};
    await syncNow(transport);
    expect((await db.notes.get(note.id))?.content).toBe("响应回来前的新输入");
    const pending=await db.outbox.toArray();expect(pending).toHaveLength(1);expect(pending[0].baseRevision).toBe(1);
  });

  it("世代变化把待上传修改移入可恢复草稿，不推回旧库", async () => {
    const note=await createNote();await updateNote(note.id,{content:"不能丢的离线修改"});
    await db.meta.put({key:"vaultEpoch",value:"old"});
    const push=vi.fn();
    await syncNow({state:async()=>({epoch:"new"}),push,pull:async()=>({notes:[],cursor:"0",epoch:"new"})});
    expect(push).not.toHaveBeenCalled();expect(await db.outbox.count()).toBe(0);
    expect((await db.recoveryDrafts.toArray())[0].note.content).toBe("不能丢的离线修改");
    expect((await db.meta.get("vaultEpoch"))?.value).toBe("new");
  });

  it("远端永久删除保留尚未上传的修改", async () => {
    const note=await createNote();
    await syncNow({push:async()=>({ok:false}),pull:async()=>({notes:[],deletedIds:[note.id],cursor:"1"})});
    expect(await db.recoveryDrafts.count()).toBe(1);
    expect((await db.recoveryDrafts.toArray())[0].note.id).toBe(note.id);
  });

});
