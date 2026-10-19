import {useEffect,useRef,useState} from 'react';
import {localizeMessage,t} from './i18n';

type Notice={id:number;message:string;error:boolean};
/** Save locally before acknowledging; server sync continues independently. */
export function useSaveShortcut(enabled:boolean,save:()=>Promise<boolean>) {
  const latest=useRef(save);latest.current=save;
  const [notice,setNotice]=useState<Notice|null>(null);
  const sequence=useRef(0),busy=useRef(false);
  useEffect(()=>{
    if(!enabled)return;
    let mounted=true;
    let timer:number|undefined;
    const show=(message:string,error=false)=>{
      if(!mounted)return;
      window.clearTimeout(timer);
      setNotice({id:++sequence.current,message,error});
      timer=window.setTimeout(()=>setNotice(null),error?6000:2800);
    };
    const handle=(event:KeyboardEvent)=>{
      if(!(event.ctrlKey||event.metaKey)||event.altKey||event.shiftKey||(event.key.toLowerCase()!=='s'&&event.code!=='KeyS'))return;
      event.preventDefault();event.stopPropagation();
      if(event.repeat||busy.current)return;
      busy.current=true;
      void (async()=>{
        try {
          const changed=await latest.current();
          show(changed?t('已保存到本机'):t('笔记已自动保存'));
        }catch(reason){show(t('保存失败，请重试：{0}',localizeMessage(reason instanceof Error?reason.message:String(reason))),true);}
        finally{busy.current=false;}
      })();
    };
    window.addEventListener('keydown',handle,true);
    return()=>{mounted=false;window.clearTimeout(timer);window.removeEventListener('keydown',handle,true);};
  },[enabled]);
  return notice;
}
