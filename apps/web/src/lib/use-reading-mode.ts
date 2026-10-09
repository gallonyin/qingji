import {useCallback, useEffect, useRef, useState} from 'react';

export function useReadingMode(preview: boolean, setPreview: (value: boolean) => void) {
  const [active, setActive] = useState(false);
  const previousPreview = useRef(preview);
  const trigger = useRef<HTMLButtonElement>(null);
  const enter = () => {
    previousPreview.current = preview;
    setPreview(true); setActive(true);
    requestAnimationFrame(() => document.querySelector<HTMLElement>('.note-content')?.focus({preventScroll: true}));
  };
  const exit = useCallback(() => {
    setActive(false); setPreview(previousPreview.current);
    requestAnimationFrame(() => trigger.current?.focus({preventScroll: true}));
  }, [setPreview]);
  useEffect(() => {
    if (!active) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing) {event.preventDefault(); exit();}
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [active, exit]);
  return {active, enter, exit, trigger};
}

export type ReadingPreferences = {theme: 'paper' | 'light' | 'dark'; fontSize: number; width: 'comfortable' | 'wide'};
const defaults: ReadingPreferences = {theme: 'paper', fontSize: 19, width: 'comfortable'};
export function readReadingPreferences(): ReadingPreferences {
  try {
    const value = JSON.parse(localStorage.getItem('qingji:reading') ?? '{}');
    return {
      theme: ['paper', 'light', 'dark'].includes(value.theme) ? value.theme : defaults.theme,
      fontSize: typeof value.fontSize === 'number' && Number.isFinite(value.fontSize) ? Math.max(16, Math.min(26, value.fontSize)) : defaults.fontSize,
      width: value.width === 'wide' ? 'wide' : defaults.width
    };
  } catch {return defaults;}
}
export function useReadingPreferences() {
  const [preferences, setPreferences] = useState(readReadingPreferences);
  const update = (patch: Partial<ReadingPreferences>) => {
    setPreferences(current => {
      const next = {...current, ...patch};
      try {localStorage.setItem('qingji:reading', JSON.stringify(next));} catch { /* Reading remains available when storage is unavailable. */ }
      return next;
    });
  };
  return {preferences, update};
}
