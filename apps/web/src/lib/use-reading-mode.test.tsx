import {useState} from 'react';
import {act, cleanup, fireEvent, render, renderHook, screen} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
import {useReadingMode, readReadingPreferences} from './use-reading-mode';
import {NoteFind} from '../components/NoteFind';
import {MarkdownPreview} from '../components/MarkdownPreview';
import {createRef} from 'react';
import type {NoteFindEditor} from './note-find';

afterEach(cleanup);
it('enters preview and restores the prior source mode on exit', () => {
  const {result} = renderHook(() => {
    const [preview, setPreview] = useState(false);
    return {preview, reading: useReadingMode(preview, setPreview)};
  });
  act(() => result.current.reading.enter());
  expect(result.current.preview).toBe(true); expect(result.current.reading.active).toBe(true);
  act(() => fireEvent.keyDown(window, {key: 'Escape'}));
  expect(result.current.reading.active).toBe(false); expect(result.current.preview).toBe(false);
});
it('Escape closes note search before exiting reading and ignores composition', () => {
  const ref = createRef<NoteFindEditor>();
  function Reader() {
    const [preview, setPreview] = useState(true);
    const reading = useReadingMode(preview, setPreview);
    return <><button onClick={reading.enter}>Enter</button><span>{reading.active ? 'reading' : 'normal'}</span><NoteFind preview={preview} content="alpha" editorRef={ref}><MarkdownPreview content="alpha" onNavigate={vi.fn()}/></NoteFind></>;
  }
  render(<Reader/>); fireEvent.click(screen.getByText('Enter'));
  fireEvent.keyDown(screen.getByLabelText('正文阅读区'), {key: 'f', ctrlKey: true});
  fireEvent.keyDown(screen.getByRole('textbox', {name: '搜索当前笔记'}), {key: 'Escape'});
  expect(screen.queryByRole('search')).toBeNull(); expect(screen.getByText('reading')).toBeInTheDocument();
  fireEvent.keyDown(window, {key: 'Escape', isComposing: true}); expect(screen.getByText('reading')).toBeInTheDocument();
  fireEvent.keyDown(window, {key: 'Escape'}); expect(screen.getByText('normal')).toBeInTheDocument();
});
it('validates browser-local reading preferences', () => {
  localStorage.setItem('qingji:reading', '{broken');
  expect(readReadingPreferences()).toEqual({theme: 'paper', fontSize: 19, width: 'comfortable'});
  localStorage.setItem('qingji:reading', JSON.stringify({theme: 'dark', fontSize: 100, width: 'wide'}));
  expect(readReadingPreferences()).toEqual({theme: 'dark', fontSize: 26, width: 'wide'});
  localStorage.setItem('qingji:reading', 'null'); expect(readReadingPreferences().fontSize).toBe(19);
});
