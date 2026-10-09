import {expect, it} from 'vitest';
import {findText, indexRenderedText, MAX_FIND_MATCHES} from './note-find';

it('finds literal text with Unicode case handling and bounds excessive matches', () => {
  expect(findText('A.b a.b aXb', 'a.b', false).matches).toEqual([{from: 0, to: 3}, {from: 4, to: 7}]);
  expect(findText('A.b a.b', 'a.b', true).matches).toHaveLength(1);
  expect(findText('中文 日本語 中文', '中文', false).matches).toHaveLength(2);
  expect(findText('hello', '', false).matches).toEqual([]);
  const result = findText('a'.repeat(MAX_FIND_MATCHES + 1), 'a', false);
  expect(result.matches).toHaveLength(MAX_FIND_MATCHES); expect(result.limited).toBe(true);
});
it('matches rendered text across inline formatting, but not across paragraphs or table cells', () => {
  const root = document.createElement('article');
  root.innerHTML = '<p>Hello <strong>beautiful</strong> world</p><p>second paragraph</p><table><tr><td>left</td><td>right</td></tr></table><span hidden>secret</span>';
  const indexed = indexRenderedText(root);
  const matches = findText(indexed.text, 'Hello beautiful world', false).matches;
  expect(matches).toHaveLength(1); expect(indexed.range(matches[0]).toString()).toBe('Hello beautiful world');
  expect(findText(indexed.text, 'worldsecond', false).matches).toEqual([]);
  expect(findText(indexed.text, 'leftright', false).matches).toEqual([]);
  expect(indexed.text).not.toContain('secret');
});
