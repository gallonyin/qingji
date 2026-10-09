import {useEffect, useState, type RefObject} from 'react';
import {Minimize2} from 'lucide-react';
import {t, useLocale} from '../lib/i18n';
import type {ReadingPreferences} from '../lib/use-reading-mode';

type Props = {host: RefObject<HTMLElement | null>; content: string; preferences: ReadingPreferences; update: (patch: Partial<ReadingPreferences>) => void; onExit: () => void};
export function ReadingToolbar({host, content, preferences, update, onExit}: Props) {
  useLocale();
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    const scroller = host.current?.querySelector<HTMLElement>('.note-content');
    if (!scroller) return;
    const measure = () => {
      const distance = scroller.scrollHeight - scroller.clientHeight;
      setProgress(distance > 1 ? Math.round(Math.max(0, Math.min(1, scroller.scrollTop / distance)) * 100) : 100);
    };
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(scroller);
    const article = scroller.querySelector('.editor-area'); if (article) observer?.observe(article);
    scroller.addEventListener('scroll', measure, {passive: true}); scroller.addEventListener('load', measure, true);
    window.addEventListener('resize', measure); measure();
    return () => {observer?.disconnect(); scroller.removeEventListener('scroll', measure); scroller.removeEventListener('load', measure, true); window.removeEventListener('resize', measure);};
  }, [host, content]);
  return <header className="reading-toolbar" aria-label={t('阅读设置')}>
    <span className="reading-label">{t('沉浸阅读')}</span>
    <div className="reading-controls">
      <label>{t('字号')}<select aria-label={t('阅读字号')} value={preferences.fontSize} onChange={event => update({fontSize: Number(event.target.value)})}>{[16,17,18,19,20,21,22,23,24,25,26].map(size => <option key={size} value={size}>{size}px</option>)}</select></label>
      <label>{t('宽度')}<select aria-label={t('阅读宽度')} value={preferences.width} onChange={event => update({width: event.target.value as ReadingPreferences['width']})}><option value="comfortable">{t('舒适')}</option><option value="wide">{t('宽屏')}</option></select></label>
      <label>{t('主题')}<select aria-label={t('阅读主题')} value={preferences.theme} onChange={event => update({theme: event.target.value as ReadingPreferences['theme']})}><option value="paper">{t('纸色')}</option><option value="light">{t('白色')}</option><option value="dark">{t('深色')}</option></select></label>
    </div>
    <button className="reading-exit" onClick={onExit} title={t('退出沉浸模式（Esc）')}><Minimize2 size={16}/><span>{t('退出沉浸模式')}</span><kbd>Esc</kbd></button>
    <div className="reading-progress" role="progressbar" aria-label={t('阅读进度')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{width: `${progress}%`}}/></div>
  </header>;
}
