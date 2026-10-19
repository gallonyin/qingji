import {Check,TriangleAlert,X} from 'lucide-react';
import {t,useLocale} from '../lib/i18n';
import type {ToastNotice} from '../lib/use-toast';
/** Shared presentation for save, settings, and future transient notices. */
export function Toast({notice}:{notice:ToastNotice|null}) {
  useLocale();
  if(!notice)return null;
  return <div key={notice.id} className={`toast ${notice.error?'toast-error':'toast-success'}`}>
    <span className="toast-icon" aria-hidden="true">{notice.error?<TriangleAlert size={16}/>:<Check size={16} strokeWidth={2}/>}</span>
    <span className="toast-message" role={notice.error?'alert':'status'} aria-live={notice.error?'assertive':'polite'} aria-atomic="true">{notice.message}</span>
    <button className="toast-close" type="button" onClick={notice.dismiss} aria-label={t('关闭提示')}><X size={14}/></button>
  </div>;
}
