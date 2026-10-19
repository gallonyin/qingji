import {useCallback,useEffect,useRef,useState} from 'react';
export type ToastNotice={id:number;message:string;error:boolean;dismiss:()=>void};
/** Shared timing and replacement policy for transient feedback. */
export function useToast() {
  const [notice,setNotice]=useState<ToastNotice|null>(null);
  const sequence=useRef(0),timer=useRef<number|undefined>(undefined);
  const dismiss=useCallback(()=>{window.clearTimeout(timer.current);setNotice(null);},[]);
  const show=useCallback((message:string,error=false)=>{
    window.clearTimeout(timer.current);
    setNotice({id:++sequence.current,message,error,dismiss});
    timer.current=window.setTimeout(dismiss,error?6000:2800);
  },[dismiss]);
  useEffect(()=>()=>window.clearTimeout(timer.current),[]);
  return {notice,show,dismiss};
}
