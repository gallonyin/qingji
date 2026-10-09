import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';

/** Measure at interaction time so window/panel resizing never leaves stale decisions. */
function needsTooltip(node:HTMLElement) {
  if(node.dataset.tooltipMode==='always')return true;
  const selector=node.dataset.tooltipOverflow;
  const labels=selector?Array.from(node.querySelectorAll<HTMLElement>(selector)):[node];
  return labels.some(label=>label.clientWidth>0&&label.clientHeight>0&&
    (label.scrollWidth>label.clientWidth+1||label.scrollHeight>label.clientHeight+1));
}

/** One shared tooltip escapes the scrolling panels that would otherwise clip hints. */
export function HoverTooltip() {
  const [target,setTarget]=useState<HTMLElement|null>(null);
  const box=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    let showTimer:ReturnType<typeof setTimeout>|undefined;
    let closeTimer:ReturnType<typeof setTimeout>|undefined;
    let active:HTMLElement|null=null,dragging=false,inside=false;
    const cancelClose=()=>clearTimeout(closeTimer);
    const hide=()=>{clearTimeout(showTimer);cancelClose();active=null;setTarget(null);};
    const closeLater=()=>{
      clearTimeout(showTimer);cancelClose();
      if(!dragging)closeTimer=setTimeout(hide,350);
    };
    const inBubble=(node:EventTarget|null)=>node instanceof Node&&!!box.current?.contains(node);
    const show=(event:Event)=>{
      if(inBubble(event.target)){inside=true;cancelClose();clearTimeout(showTimer);return;}
      const node=event.target instanceof Element?event.target.closest<HTMLElement>('[data-tooltip]'):null;
      clearTimeout(showTimer);
      if(!node?.dataset.tooltip||!needsTooltip(node)){
        inside=false;
        if(event.type==='focusin')hide();else closeLater();
        return;
      }
      inside=true;cancelClose();
      if(active&&box.current&&(node===active||active.contains(node)||node.contains(active)))return;
      const reveal=()=>{if(node.isConnected&&needsTooltip(node)){active=node;setTarget(node);}};
      if(event.type==='focusin')reveal();else showTimer=setTimeout(reveal,1000);
    };
    const leave=(event:Event)=>{
      const from=event.target instanceof Element?event.target.closest('[data-tooltip]'):null;
      const next=(event as MouseEvent|FocusEvent).relatedTarget;
      if(inBubble(next)||(from&&next instanceof Node&&from.contains(next)))return;
      if(active&&next instanceof Node&&active.contains(next))return;
      inside=false;closeLater();
    };
    const down=(event:MouseEvent)=>{if(inBubble(event.target)){dragging=true;cancelClose();}};
    const up=()=>{dragging=false;if(!inside)closeLater();};
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape')hide();};
    document.addEventListener('mouseover',show);
    document.addEventListener('mouseout',leave);
    document.addEventListener('focusin',show);
    document.addEventListener('focusout',leave);
    document.addEventListener('mousedown',down);
    document.addEventListener('mouseup',up);
    document.addEventListener('scroll',hide,true);
    document.addEventListener('keydown',key);
    window.addEventListener('resize',hide);
    window.addEventListener('blur',hide);
    return()=>{
      clearTimeout(showTimer);cancelClose();
      document.removeEventListener('mouseover',show);document.removeEventListener('mouseout',leave);
      document.removeEventListener('focusin',show);document.removeEventListener('focusout',leave);
      document.removeEventListener('mousedown',down);document.removeEventListener('mouseup',up);
      document.removeEventListener('scroll',hide,true);document.removeEventListener('keydown',key);
      window.removeEventListener('resize',hide);window.removeEventListener('blur',hide);
    };
  },[]);
  useEffect(()=>{
    if(!target)return;
    const observer=new ResizeObserver(()=>{if(!needsTooltip(target))setTarget(null);});
    observer.observe(target);
    if(target.dataset.tooltipOverflow)target.querySelectorAll(target.dataset.tooltipOverflow).forEach(label=>observer.observe(label));
    return()=>observer.disconnect();
  },[target]);
  useLayoutEffect(()=>{
    if(!target||!box.current)return;
    const anchor=target.getBoundingClientRect(),tip=box.current.getBoundingClientRect();
    const left=Math.max(8,Math.min(anchor.left,window.innerWidth-tip.width-8));
    const below=anchor.bottom+8+tip.height<=window.innerHeight-8;
    const top=below?anchor.bottom+8:Math.max(8,anchor.top-tip.height-8);
    box.current.dataset.placement=below?'below':'above';
    // A hit-testable bridge covers the gap; crossing it must not enter another row.
    const bridgeLeft=Math.min(anchor.left,left)-left;
    box.current.style.setProperty('--bridge-left',`${bridgeLeft}px`);
    box.current.style.setProperty('--bridge-width',`${Math.max(anchor.right,left+tip.width)-Math.min(anchor.left,left)}px`);
    box.current.style.left=`${left}px`;box.current.style.top=`${top}px`;
  },[target]);
  return target?createPortal(<div ref={box} role="tooltip" tabIndex={0} className="hover-tooltip">{target.dataset.tooltip}</div>,document.body):null;
}
