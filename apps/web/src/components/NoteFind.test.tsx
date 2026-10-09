import {createRef, StrictMode} from 'react';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
import {EditorView} from '@codemirror/view';
import {NoteFind} from './NoteFind';
import {MarkdownEditor} from './MarkdownEditor';
import {MarkdownPreview} from './MarkdownPreview';
import type {NoteFindEditor} from '../lib/note-find';
import {setLocale} from '../lib/i18n';

afterEach(cleanup);
const editorRef = () => createRef<NoteFindEditor>();
function previewUi(content = 'Alpha **beta** alpha') {
  return render(<><input aria-label="Sidebar search"/><p>alpha outside the article</p><NoteFind content={content} preview editorRef={editorRef()}><MarkdownPreview content={content} onNavigate={vi.fn()}/></NoteFind></>);
}
function openFind(ui: ReturnType<typeof render>, metaKey = false) {
  const article = ui.getByLabelText('正文阅读区'); article.focus();
  expect(fireEvent.keyDown(article, {key: 'f', ctrlKey: !metaKey, metaKey})).toBe(false);
  return ui.getByRole('textbox', {name: '搜索当前笔记'});
}
it('only intercepts shortcuts inside the article and searches rendered content, not sidebar text', async () => {
  const ui = previewUi();
  const outside = ui.getByLabelText('Sidebar search'); outside.focus();
  expect(fireEvent.keyDown(outside, {key: 'f', ctrlKey: true})).toBe(true);
  expect(ui.queryByRole('search')).toBeNull();
  const input = openFind(ui);
  await waitFor(() => expect(input).toHaveFocus());
  fireEvent.change(input, {target: {value: 'alpha'}});
  expect(ui.getByRole('status')).toHaveTextContent('1 / 2');
  fireEvent.keyDown(input, {key: 'Enter'}); expect(ui.getByRole('status')).toHaveTextContent('2 / 2');
  fireEvent.keyDown(input, {key: 'Enter'}); expect(ui.getByRole('status')).toHaveTextContent('1 / 2');
  fireEvent.keyDown(input, {key: 'Enter', shiftKey: true}); expect(ui.getByRole('status')).toHaveTextContent('2 / 2');
  fireEvent.click(ui.getByRole('button', {name: '区分大小写'})); expect(ui.getByRole('status')).toHaveTextContent('1 / 1');
  fireEvent.change(input, {target: {value: 'Alpha beta'}}); expect(ui.getByRole('status')).toHaveTextContent('1 / 1');
  fireEvent.keyDown(input, {key: 'Escape'}); expect(ui.queryByRole('search')).toBeNull();
  expect(ui.getByLabelText('正文阅读区')).toHaveFocus();
});
it('handles Cmd+F, no results, language changes, and preview content updates', () => {
  const ref = editorRef();
  const view = (content: string) => <NoteFind content={content} preview editorRef={ref}><MarkdownPreview content={content} onNavigate={vi.fn()}/></NoteFind>;
  const ui = render(view('one one')); const input = openFind(ui, true);
  fireEvent.change(input, {target: {value: 'missing'}});
  expect(ui.getByRole('status')).toHaveTextContent('没有匹配');
  expect(ui.getByRole('button', {name: '下一处匹配'})).toBeDisabled();
  fireEvent.change(input, {target: {value: 'one'}}); expect(ui.getByRole('status')).toHaveTextContent('1 / 2');
  ui.rerender(view('one')); expect(ui.getByRole('status')).toHaveTextContent('1 / 1');
  act(() => setLocale('ja'));
  expect(ui.getByRole('textbox', {name: '現在のノートを検索'})).toHaveValue('one');
  expect(ui.getByRole('search', {name: 'ノート内検索'})).toBeInTheDocument();
});
it('source search highlights and navigates without editing, and survives switching modes', () => {
  const ref = editorRef(), changed = vi.fn(); const content = 'Alpha **beta** alpha';
  const view = (preview: boolean, text = content) => <NoteFind content={text} preview={preview} editorRef={ref}>{preview ? <MarkdownPreview content={text} onNavigate={vi.fn()}/> : <MarkdownEditor searchRef={ref} value={text} onChange={changed}/>}</NoteFind>;
  const ui = render(view(false));
  const editor = EditorView.findFromDOM(ui.container.querySelector('.cm-editor')!)!;
  editor.contentDOM.focus();
  expect(fireEvent.keyDown(editor.contentDOM, {key: 'f', ctrlKey: true})).toBe(false);
  const input = ui.getByRole('textbox', {name: '搜索当前笔记'});
  fireEvent.change(input, {target: {value: 'alpha'}});
  expect(ui.getByRole('status')).toHaveTextContent('1 / 2');
  expect(editor.state.selection.main.from).toBe(0);
  fireEvent.keyDown(input, {key: 'Enter'}); expect(editor.state.selection.main.from).toBe(15);
  expect(ui.container.querySelectorAll('.cm-note-find')).toHaveLength(2);
  expect(changed).not.toHaveBeenCalled();
  fireEvent.change(input, {target: {value: 'Alpha beta'}}); expect(ui.getByRole('status')).toHaveTextContent('没有匹配');
  ui.rerender(view(true)); expect(ui.getByRole('status')).toHaveTextContent('1 / 1');
  ui.rerender(view(false)); expect(ui.getByRole('status')).toHaveTextContent('没有匹配');
  fireEvent.change(input, {target: {value: 'alpha'}});
  ui.rerender(view(false, 'alpha')); expect(ui.getByRole('status')).toHaveTextContent('1 / 1');
  fireEvent.keyDown(input, {key: 'Escape'});
  expect(ui.container.querySelector('.cm-note-find')).toBeNull();
  expect(changed).not.toHaveBeenCalled();
});

it('restores source highlights when an open preview search mounts an editor in StrictMode', async () => {
  const ref = editorRef();
  const view = (preview: boolean) => <StrictMode><NoteFind content="alpha alpha" preview={preview} editorRef={ref}>{preview ? <MarkdownPreview content="alpha alpha" onNavigate={vi.fn()}/> : <MarkdownEditor searchRef={ref} value="alpha alpha" onChange={vi.fn()}/>}</NoteFind></StrictMode>;
  const ui = render(view(true));
  fireEvent.change(openFind(ui), {target: {value: 'alpha'}});
  ui.rerender(view(false));
  await waitFor(() => expect(ui.container.querySelectorAll('.cm-note-find')).toHaveLength(2));
});
