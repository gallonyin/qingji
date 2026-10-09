import {useSyncExternalStore} from 'react';
import {messages} from './messages';

export type Locale = 'zh-CN' | 'en' | 'ja';
export const LOCALE_KEY = 'qingji:locale';
const listeners = new Set<() => void>();
export function resolveLocale(value: string | null | undefined): Locale {
  if (value?.toLowerCase().startsWith('zh')) return 'zh-CN';
  if (value?.toLowerCase().startsWith('ja')) return 'ja';
  return 'en';
}
function initialLocale(): Locale {
  try {
    const stored = localStorage.getItem(LOCALE_KEY);
    if (stored === 'zh-CN' || stored === 'en' || stored === 'ja') return stored;
  } catch { /* Storage restrictions must not prevent using the app. */ }
  return resolveLocale(typeof navigator === 'undefined' ? 'en' : navigator.language);
}
let locale = initialLocale();
export function getLocale(): Locale { return locale; }
function notify() {
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
  for (const listener of listeners) listener();
}
export function setLocale(value: Locale) {
  if (!['zh-CN', 'en', 'ja'].includes(value)) return;
  locale = value;
  try { localStorage.setItem(LOCALE_KEY, value); } catch { /* Keep the in-memory preference. */ }
  notify();
}
export function useLocale(): Locale {
  return useSyncExternalStore(listener => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, getLocale, () => 'en');
}
if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key !== LOCALE_KEY && event.key !== null) return;
    locale = initialLocale();
    notify();
  });
  document.documentElement.lang = locale;
}
/** Substitute whole messages so languages can reorder values without translating user content. */
export function t(source: string, ...values: (string | number | null | undefined)[]): string {
  const translation = locale === 'zh-CN' ? source : messages[source]?.[locale === 'en' ? 0 : 1] ?? source;
  return translation.replace(/\{(\d+)\}/g, (placeholder, index) => {
    const value = values[Number(index)];
    return value === undefined ? placeholder : String(value ?? '');
  });
}
export function displayBrandName(branding: {name: string}): string {
  return branding.name === '轻记' ? (locale === 'en' ? 'Qingji' : locale === 'ja' ? '軽記' : '轻记') : branding.name;
}

/** Re-render existing UI errors/notices in the new language without touching note data. */
export function localizeMessage(message: string): string {
  if (messages[message]) return t(message);
  for (const [source, translations] of Object.entries(messages)) {
    for (const template of [source, ...translations]) {
      if (template === message) return t(source);
      if (!/\{\d+\}/.test(template)) continue;
      const indexes: number[] = [];
      const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = escaped.replace(/\\\{(\d+)\\\}/g, (_, index) => {
        indexes.push(Number(index));
        return '([\\s\\S]*?)';
      });
      const match = new RegExp('^' + pattern + '$').exec(message);
      if (!match) continue;
      const values: string[] = [];
      indexes.forEach((index, position) => { values[index] = match[position + 1]; });
      return t(source, ...values);
    }
  }
  return message;
}
