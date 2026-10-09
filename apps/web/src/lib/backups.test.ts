import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBackup, getBackupStatus, listBackups, restoreBackup } from "./backups";

const snapshot = {
  id: "2026-08-02T00-00-00-000Z-test",
  createdAt: "2026-08-02T00:00:00.000Z",
  reason: "manual",
  fileCount: 0,
  totalBytes: 0
};

describe("S3 backup API", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("mynote:token", "test-token");
    vi.restoreAllMocks();
  });

  it("读取状态、快照并携带登录令牌", async () => {
    const request = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        configured: true,
        running: false,
        lastBackup: snapshot,
        lastError: null,
        retention: 30,
        intervalHours: 24
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ snapshots: [snapshot] }), { status: 200 }));

    expect((await getBackupStatus()).configured).toBe(true);
    expect(await listBackups()).toEqual([snapshot]);
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("/backups/status"),
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer test-token" }) })
    );
  });

  it("创建备份并用快照 ID 二次确认恢复", async () => {
    const request = vi.spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(JSON.stringify({ job: {id:"job-1",kind:"backup",state:"queued"} }), { status: 202 }));

    expect((await createBackup()).state).toBe("queued");
    await restoreBackup(snapshot.id);

    expect(request.mock.calls[1]?.[0]).toContain(`/backups/${snapshot.id}/restore`);
    expect(JSON.parse(String(request.mock.calls[1]?.[1]?.body))).toEqual({ confirm: snapshot.id });
  });
});
