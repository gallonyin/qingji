import {getLocale, setLocale, t, useLocale, type Locale} from '../lib/i18n';

export function LanguageSelect() {
  useLocale();
  return <select className="language-select" aria-label={t('界面语言')} value={getLocale()} onChange={event => setLocale(event.target.value as Locale)}>
    <option value="zh-CN">简体中文</option>
    <option value="en">English</option>
    <option value="ja">日本語</option>
  </select>;
}
