import {render, fireEvent, screen, cleanup, act} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
import {LanguageSelect} from '../components/LanguageSelect';
import {getLocale, setLocale, resolveLocale, localizeMessage, t, LOCALE_KEY, displayBrandName} from './i18n';
import {messages} from './messages';

afterEach(cleanup);
it('switches immediately, persists the preference, and sets document language', () => {
  render(<LanguageSelect/>);
  fireEvent.change(screen.getByRole('combobox'), {target: {value: 'en'}});
  expect(getLocale()).toBe('en');
  expect(document.documentElement.lang).toBe('en');
  expect(localStorage.getItem(LOCALE_KEY)).toBe('en');
  expect(screen.getByLabelText('Interface language')).toHaveValue('en');
  fireEvent.change(screen.getByRole('combobox'), {target: {value: 'ja'}});
  expect(screen.getByLabelText('表示言語')).toHaveValue('ja');
  expect(t('设置')).toBe('設定');
});
it('follows another tab and works even if preference storage is unavailable', () => {
  render(<LanguageSelect/>);
  localStorage.setItem(LOCALE_KEY, 'ja');
  act(() => window.dispatchEvent(new StorageEvent('storage', {key: LOCALE_KEY, newValue: 'ja'})));
  expect(screen.getByLabelText('表示言語')).toHaveValue('ja');
  const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {throw new Error('blocked');});
  act(() => setLocale('en'));
  expect(screen.getByLabelText('Interface language')).toHaveValue('en');
  storage.mockRestore();
});
it('covers all catalog placeholders, reorders values, and never translates user data', () => {
  const placeholders = (text: string) => [...text.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
  for (const [source, translations] of Object.entries(messages)) {
    for (const value of translations) {
      expect(value.trim(), source).not.toBe('');
      expect(placeholders(value), source).toEqual(placeholders(source));
    }
  }
  setLocale('ja');
  expect(t('{0}目录 {1}', t('展开'), 'My {0} notes')).toBe('フォルダー My {0} notesを展開');
  expect(displayBrandName({name: 'My notebook'})).toBe('My notebook');
  expect(displayBrandName({name: '轻记'})).toBe('軽記');
  expect(resolveLocale('ja-JP')).toBe('ja');
  expect(resolveLocale('zh-TW')).toBe('zh-CN');
  expect(resolveLocale('fr-FR')).toBe('en');
});

it('existing errors and notices follow a language switch, including dynamic status values', () => {
  setLocale('en');
  const error = t('正文读取失败（{0}）', 503);
  const notice = t('已保存，设置已生效。');
  setLocale('ja');
  expect(localizeMessage(error)).toBe('ノートを読み込めません（503）');
  expect(localizeMessage(notice)).toBe('保存しました。設定が適用されました。');
  expect(localizeMessage('An unknown upstream diagnostic')).toBe('An unknown upstream diagnostic');
});
