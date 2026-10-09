import {useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject} from 'react';
import {ArrowDown, ArrowUp, Search, X} from 'lucide-react';
import {t, useLocale} from '../lib/i18n';
import {findText, indexRenderedText, MAX_FIND_MATCHES, type NoteFindEditor, type TextMatch} from '../lib/note-find';

type Props = {content: string; preview: boolean; editorRef: RefObject<NoteFindEditor | null>; children: ReactNode};
type Box = {left: number; top: number; width: number; height: number; active: boolean};

export function NoteFind({content, preview, editorRef, children}: Props) {
  useLocale();
  const root = useRef<HTMLDivElement>(null), field = useRef<HTMLInputElement>(null), previousFocus = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [caseSensitive, setCaseSensitive] = useState(false);
  const [active, setActive] = useState(0), [count, setCount] = useState(0), [limited, setLimited] = useState(false), [boxes, setBoxes] = useState<Box[]>([]);
  const matches = useRef<TextMatch[]>([]), ranges = useRef<Range[]>([]);
  const allName = 'qingji_find_all_' + useId().replace(/\W/g, '_'), activeName = allName + '_active';
  const nativeHighlights = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';
  const clearHighlights = useCallback(() => {
    editorRef.current?.clear();
    if (nativeHighlights) {CSS.highlights.delete(allName); CSS.highlights.delete(activeName);}
    ranges.current = [];
  }, [allName, activeName, editorRef, nativeHighlights]);

  const updateBoxes = useCallback(() => {
    if (nativeHighlights || !root.current) return;
    const host = root.current, rect = host.getBoundingClientRect();
    const next: Box[] = [];
    ranges.current.forEach((range, index) => {
      for (const box of Array.from(range.getClientRects())) {
        if (box.bottom < rect.top || box.top > rect.bottom) continue;
        next.push({left: box.left - rect.left + host.scrollLeft, top: box.top - rect.top + host.scrollTop, width: box.width, height: box.height, active: index === active});
      }
    });
    setBoxes(next);
  }, [nativeHighlights, active]);

  const showMatch = useCallback((index: number) => {
    if (!preview) {editorRef.current?.highlight(matches.current, index); return;}
    const range = ranges.current[index];
    if (nativeHighlights) {
      CSS.highlights.set(allName, new Highlight(...ranges.current));
      CSS.highlights.set(activeName, new Highlight(...(range ? [range] : [])));
    }
    if (range && root.current) {
      const host = root.current, rect = range.getBoundingClientRect(), bounds = host.getBoundingClientRect();
      if (rect.height && (rect.top < bounds.top + 54 || rect.bottom > bounds.bottom)) {
        host.scrollTo({top: Math.max(0, host.scrollTop + rect.top - bounds.top - host.clientHeight / 2), behavior: 'auto'});
      }
    }
  }, [preview, editorRef, nativeHighlights, allName, activeName]);

  useLayoutEffect(() => {
    clearHighlights();
    if (!open) {matches.current = []; setCount(0); setBoxes([]); return;}
    const article = root.current?.querySelector<HTMLElement>('.markdown-body');
    const rendered = preview && article ? indexRenderedText(article) : null;
    const result = findText(rendered?.text ?? content, query, caseSensitive);
    matches.current = result.matches;
    ranges.current = rendered ? result.matches.map(match => rendered.range(match)) : [];
    setCount(result.matches.length); setLimited(result.limited); setActive(0);
    showMatch(0);
    // StrictMode can recreate a newly mounted editor after this layout effect.
    // Reapply once all editor mount effects have completed.
    const frame = !preview ? requestAnimationFrame(() => showMatch(0)) : 0;
    // The fallback's active index may not have changed, so redraw explicitly after querying.
    if (!nativeHighlights && root.current) {
      const host = root.current, rect = host.getBoundingClientRect();
      setBoxes(ranges.current.flatMap((range, index) => Array.from(range.getClientRects()).filter(box => box.bottom >= rect.top && box.top <= rect.bottom).map(box => ({left: box.left - rect.left + host.scrollLeft, top: box.top - rect.top + host.scrollTop, width: box.width, height: box.height, active: index === 0}))));
    }
    return () => {cancelAnimationFrame(frame); clearHighlights();};
  }, [open, query, caseSensitive, content, preview, clearHighlights, showMatch, nativeHighlights]);

  useLayoutEffect(() => {
    if (!open || !preview || nativeHighlights) return;
    const host = root.current!;
    let frame = 0;
    const update = () => {cancelAnimationFrame(frame); frame = requestAnimationFrame(updateBoxes);};
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    observer?.observe(host);
    const article = host.querySelector('.markdown-body'); if (article) observer?.observe(article);
    host.addEventListener('scroll', update); host.addEventListener('load', update, true); window.addEventListener('resize', update);
    updateBoxes();
    return () => {cancelAnimationFrame(frame); observer?.disconnect(); host.removeEventListener('scroll', update); host.removeEventListener('load', update, true); window.removeEventListener('resize', update);};
  }, [open, preview, nativeHighlights, updateBoxes]);

  const move = (direction: number) => {
    if (!matches.current.length) return;
    const index = (active + direction + matches.current.length) % matches.current.length;
    setActive(index); showMatch(index);
  };
  const close = () => {
    setOpen(false); clearHighlights();
    const target = previousFocus.current;
    if (target?.isConnected && root.current?.contains(target)) target.focus({preventScroll: true});
    else root.current?.focus({preventScroll: true});
  };
  return <div ref={root} className={`note-content ${preview ? 'preview-content' : 'source-content'}`} tabIndex={0} aria-label={t('正文阅读区')}
    onMouseDown={event => {
      if (!(event.target as HTMLElement).closest('input,textarea,button,a,select,[contenteditable="true"]')) root.current?.focus({preventScroll: true});
    }}
    onKeyDownCapture={event => {
      if (event.nativeEvent.isComposing) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') {
        event.preventDefault(); event.stopPropagation();
        if (!open) {
          previousFocus.current = document.activeElement as HTMLElement;
          const selection = window.getSelection();
          const selected = preview ? (selection?.anchorNode && selection.focusNode && root.current?.contains(selection.anchorNode) && root.current.contains(selection.focusNode) ? selection.toString() : '') : editorRef.current?.selectedText() ?? '';
          if (selected && selected.length <= 200 && !selected.includes('\n')) setQuery(selected);
          setOpen(true);
          requestAnimationFrame(() => {field.current?.focus(); field.current?.select();});
        } else {field.current?.focus(); field.current?.select();}
      } else if (open && event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); close();}
    }}>
    {open && <div className="note-find-bar" role="search" aria-label={t('页内搜索')}>
      <Search size={15} aria-hidden="true"/>
      <input ref={field} aria-label={t('搜索当前笔记')} placeholder={t('在当前笔记中搜索…')} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Enter') {event.preventDefault(); event.stopPropagation(); move(event.shiftKey ? -1 : 1);}
      }}/>
      <span className="note-find-count" role="status" aria-live="polite" title={limited ? t('最多显示 {0} 处匹配，请缩小搜索范围。', MAX_FIND_MATCHES) : undefined}>
        {!query ? t('仅搜索正文') : count ? t('{0} / {1}', active + 1, limited ? `${count}+` : count) : t('没有匹配')}
      </span>
      <button className="icon-btn note-find-case" aria-label={t('区分大小写')} aria-pressed={caseSensitive} title={t('区分大小写')} onClick={() => setCaseSensitive(value => !value)}>Aa</button>
      <button className="icon-btn" disabled={!count} aria-label={t('上一处匹配')} title={t('上一处匹配')} onClick={() => move(-1)}><ArrowUp size={16}/></button>
      <button className="icon-btn" disabled={!count} aria-label={t('下一处匹配')} title={t('下一处匹配')} onClick={() => move(1)}><ArrowDown size={16}/></button>
      <button className="icon-btn" aria-label={t('关闭页内搜索')} title={t('关闭页内搜索')} onClick={close}><X size={16}/></button>
    </div>}
    {nativeHighlights && <style>{`::highlight(${allName}) { background: #ead293; color: #292724; } ::highlight(${activeName}) { background: #e9a16d; color: #292724; }`}</style>}
    {children}
    {!nativeHighlights && open && <div className="note-find-overlay" aria-hidden="true">{boxes.map((box, index) => <span key={index} className={box.active ? 'note-find-hit active' : 'note-find-hit'} style={{left: box.left, top: box.top, width: box.width, height: box.height}}/>)}</div>}
  </div>;
}
