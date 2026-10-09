import { afterEach, describe, expect, it, vi } from "vitest";
import { createUuid } from "./uuid";

describe("createUuid", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("在非安全 HTTP 环境没有 randomUUID 时仍生成 RFC 4122 UUID", () => {
    let seed = 0;
    vi.stubGlobal("crypto", {
      randomUUID: undefined,
      getRandomValues<T extends ArrayBufferView>(value: T): T {
        const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        bytes.forEach((_, index) => {
          bytes[index] = seed++ & 0xff;
        });
        return value;
      }
    });

    expect(createUuid()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });
});
