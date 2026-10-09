import {EditorView} from '@codemirror/view';
import {setLocale} from '../lib/i18n';
import { act, render, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownEditor } from "./MarkdownEditor";

afterEach(cleanup);

describe("MarkdownEditor", () => {
  it("切换笔记或拉取远端内容时不会误触发本地编辑", () => {
    const onChange = vi.fn();
    const view = render(<MarkdownEditor value="第一篇内容" onChange={onChange} />);

    view.rerender(<MarkdownEditor value="远端同步后的第二篇内容" onChange={onChange} />);

    expect(onChange).not.toHaveBeenCalled();
    expect(view.container).toHaveTextContent("远端同步后的第二篇内容");
  });
});


it('switching language preserves editor text and selection without generating edits', () => {
  const onChange = vi.fn();
  const ui = render(<MarkdownEditor value="User content stays unchanged" onChange={onChange}/>);
  const editor = EditorView.findFromDOM(ui.container.querySelector('.cm-editor')!)!;
  editor.dispatch({selection: {anchor: 5}});
  act(() => setLocale('ja'));
  expect(EditorView.findFromDOM(ui.container.querySelector('.cm-editor')!)).toBe(editor);
  expect(editor.state.doc.toString()).toBe('User content stays unchanged');
  expect(editor.state.selection.main.anchor).toBe(5);
  expect(editor.state.phrase('Find')).toBe('検索');
  expect(ui.getByRole('textbox', {name: 'Markdownエディター'})).toBeInTheDocument();
  act(() => setLocale('en'));
  expect(editor.state.phrase('Find')).toBe('Find');
  expect(onChange).not.toHaveBeenCalled();
});
