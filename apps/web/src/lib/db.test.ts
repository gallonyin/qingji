import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNote, db, recoverDraft, purgeNote, restoreNote, seedDatabase, trashNote, updateNote } from "./db";

describe("离线笔记 store", () => {
  beforeEach(async () => {
    await db.notes.clear();
    await db.outbox.clear();
    await db.conflicts.clear();
    localStorage.clear();
  });

  it("并发初始化不会重复创建示例笔记", async () => {
    await Promise.all([seedDatabase(), seedDatabase()]);
    expect(await db.notes.count()).toBe(2);
  });

  it("连续本地修改只保留最新 outbox 快照", async () => {
    const note = await createNote();
    await updateNote(note.id, { title: "新标题", content: "正文" });

    expect((await db.notes.get(note.id))?.title).toBe("新标题");
    const jobs = await db.outbox.where("entityId").equals(note.id).toArray();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toMatchObject({ title: "新标题", content: "正文" });
  });

  it("删除为软删除且可以恢复", async () => {
    const note = await createNote();
    await trashNote(note.id);
    expect((await db.notes.get(note.id))?.deletedAt).not.toBeNull();
    expect((await db.outbox.orderBy("createdAt").last())?.operation).toBe("delete");

    await restoreNote(note.id);
    expect((await db.notes.get(note.id))?.deletedAt).toBeNull();
    expect((await db.outbox.orderBy("createdAt").last())?.operation).toBe("restore");
  });

  it("保留草稿另存新 ID，并保留附件的本地副本", async () => {
    const original = await createNote();
    await db.attachments.put({id:"draft-file",noteId:original.id,name:"a.txt",type:"text/plain",blob:new Blob(["bytes"]),createdAt:1});
    await db.recoveryDrafts.put({id:"draft",note:original,reason:"epoch changed",createdAt:1});
    const recovered = await recoverDraft("draft");
    expect(recovered?.id).not.toBe(original.id);
    expect(await db.attachments.where("noteId").equals(recovered!.id).count()).toBe(1);
    expect(await db.attachments.get("draft-file")).toBeDefined();
    expect((await db.outbox.where("entityId").equals(recovered!.id).first())?.baseRevision).toBe(0);
    expect(await db.recoveryDrafts.get("draft")).toBeUndefined();
  });

  it("永久删除会调用服务端并清理所有本地记录", async () => {
    const note = await createNote();
    await trashNote(note.id);
    localStorage.setItem("mynote:token", "test-token");
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: { "content-type": "application/json" } }
    ));

    await purgeNote(note.id);

    expect(request).toHaveBeenCalledWith(
      expect.stringContaining(`/notes/${note.id}/permanent?revision=2`),
      expect.objectContaining({ method: "DELETE" })
    );
    expect(await db.notes.get(note.id)).toBeUndefined();
    expect(await db.outbox.where("entityId").equals(note.id).count()).toBe(0);
    request.mockRestore();
  });
});
