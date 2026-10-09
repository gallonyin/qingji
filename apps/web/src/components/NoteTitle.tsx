import {t, useLocale} from '../lib/i18n';
import {useLayoutEffect,useRef} from 'react';

export function NoteTitle({value,onChange}:{value:string;onChange:(value:string)=>void}) {
  useLocale();
  const ref=useRef<HTMLTextAreaElement>(null);
  const fit=()=>{
    const element=ref.current;
    if(!element)return;
    element.style.height='0px';
    element.style.height=`${element.scrollHeight}px`;
  };
  useLayoutEffect(fit,[value]);
  useLayoutEffect(()=>{
    const element=ref.current;
    if(!element||typeof ResizeObserver==='undefined')return;
    let width=element.clientWidth;
    const observer=new ResizeObserver(()=>{
      if(element.clientWidth!==width){width=element.clientWidth;fit();}
    });
    observer.observe(element);
    return()=>observer.disconnect();
  },[]);
  return <textarea ref={ref} rows={1} maxLength={500} value={value} aria-label={t("笔记标题")} onChange={event=>onChange(event.target.value.replace(/[\r\n]+/g,' '))} onKeyDown={event=>{
    if(event.key==='Enter'&&!event.nativeEvent.isComposing){event.preventDefault();event.currentTarget.blur();}
  }}/>;
}
