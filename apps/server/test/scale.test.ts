import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

const NOTE_COUNT = 10_000;

describe("万篇笔记基线", () => {
  let app: FastifyInstance;
  let directory: string;
  let authorization: string;
  let startupMs: number;

  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "mynote-scale-"));
    const notes = path.join(directory, "notes", "批量");
    await mkdir(notes, { recursive: true });

    for (let offset = 0; offset < NOTE_COUNT; offset += 250) {
      await Promise.all(Array.from({ length: Math.min(250, NOTE_COUNT - offset) }, async (_, index) => {
        const number = offset + index;
        const id = crypto.randomUUID();
        const keyword = number === NOTE_COUNT - 1 ? "唯一中文检索目标" : "普通内容";
        const markdown = `---
id: ${id}
title: 笔记 ${number}
tags:
  - 批量
folder: 批量
revision: 1
createdAt: 2026-08-02T00:00:00.000Z
updatedAt: 2026-08-02T00:00:00.000Z
favorite: false
deletedAt: null
---
${keyword}，这是用于验证万篇规模启动与搜索的正文。
`;
        await writeFile(path.join(notes, `${id}.md`), markdown);
      }));
    }

    const started = performance.now();
    app = await buildApp({ dataDir: directory, password: "scale-password" });
    startupMs = performance.now() - started;
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { password: "scale-password" },
    });
    authorization = `Bearer ${login.json().token}`;
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("在合理时间内扫描并检索 10,000 篇中文笔记", async () => {
    const started = performance.now();
    const response = await app.inject({
      method: "GET",
      url: `/search?q=${encodeURIComponent("唯一中文检索目标")}`,
      headers: { authorization },
    });
    const searchMs = performance.now() - started;

    expect(response.statusCode).toBe(200);
    expect(response.json().results).toHaveLength(1);
    expect(startupMs).toBeLessThan(15_000);
    expect(searchMs).toBeLessThan(2_000);
  });
});
