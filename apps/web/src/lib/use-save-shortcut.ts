import {useEffect,useRef} from 'react';
import {useToast} from './use-toast';
import {localizeMessage,t} from './i18n';

/** Save locally before acknowledging; server sync continues independently. */
export function useSaveShortcut(enabled:boolean,save:()=>Promise<boolean>) {
  const latest=useRef(save);latest.current=save;
  const {notice,show}=useToast();
  const busy=useRef(false);
  useEffect(()=>{
    if(!enabled)return;
    let mounted=true;
    const handle=(event:KeyboardEvent)=>{
      if(!(event.ctrlKey||event.metaKey)||event.altKey||event.shiftKey||(event.key.toLowerCase()!=='s'&&event.code!=='KeyS'))return;
      event.preventDefault();event.stopPropagation();
      if(event.repeat||busy.current)return;
      busy.current=true;
      void (async()=>{
        try {
          const changed=await latest.current();
          if(mounted)show(changed?t('已保存到本机'):t('笔记已自动保存'));
        }catch(reason){if(mounted)show(t('保存失败，请重试：{0}',localizeMessage(reason instanceof Error?reason.message:String(reason))),true);}
        finally{busy.current=false;}
      })();
    };
    window.addEventListener('keydown',handle,true);
    return()=>{mounted=false;window.removeEventListener('keydown',handle,true);};
  },[enabled,show]);
  return notice;
}
