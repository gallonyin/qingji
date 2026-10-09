import {beforeEach} from 'vitest';
import {setLocale} from '../lib/i18n';
setLocale('zh-CN');
beforeEach(() => setLocale('zh-CN'));
import "fake-indexeddb/auto";
import "@testing-library/jest-dom/vitest";

if (!globalThis.crypto.randomUUID) {
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    value: () => `${Date.now()}-${Math.random().toString(16).slice(2)}`
  });
}

if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
}

if (!Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () => new DOMRect();
}
