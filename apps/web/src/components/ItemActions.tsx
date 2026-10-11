import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {MoreHorizontal} from 'lucide-react';
import {useLocale} from '../lib/i18n';
export type ItemAction={label:string;run:()=>void;danger?:boolean};
/** Each row has a visible, keyboard accessible menu; right click uses the same menu. */
export function ItemActions({label,actions}:{label:string;actions:ItemAction[]}) {
  useLocale();
  const [position,setPosition]=useState<{x:number;y:number}|null>(null);
  const trigger=useRef<HTMLButtonElement>(null),menu=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    if(!position)return;
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const outside=(event:PointerEvent)=>{if(!menu.current?.contains(event.target as Node)&&!trigger.current?.contains(event.target as Node))setPosition(null);};
    const close=()=>setPosition(null);
    document.addEventListener('pointerdown',outside);window.addEventListener('resize',close);window.addEventListener('scroll',close,true);
    return()=>{document.removeEventListener('pointerdown',outside);window.removeEventListener('resize',close);window.removeEventListener('scroll',close,true);};
  },[position]);
  return <>
    <button ref={trigger} className="icon-btn row-menu-trigger" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={!!position} onClick={event=>{
      event.stopPropagation();
      if(position){setPosition(null);return;}
      const r=event.currentTarget.getBoundingClientRect();
      setPosition({x:Math.max(8,Math.min(r.right-190,window.innerWidth-198)),y:Math.max(8,Math.min(r.bottom,window.innerHeight-actions.length*36-20))});
    }}><MoreHorizontal size={15}/></button>
    {position&&createPortal(<div ref={menu} className="item-actions-menu" role="menu" aria-label={label} style={{left:position.x,top:position.y}} onKeyDown={event=>{
      if(event.key==='Escape'){event.preventDefault();setPosition(null);trigger.current?.focus();}
      if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
        event.preventDefault();const buttons=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];const i=buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(i+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();
      }
      if(event.key==='Tab')setPosition(null);
    }}>{actions.map(action=><button key={action.label} role="menuitem" className={action.danger?'danger':''} onClick={()=>{setPosition(null);trigger.current?.focus();action.run();}}>{action.label}</button>)}</div>,document.body)}
  </>;
}
export function openRowMenu(event:React.MouseEvent<HTMLElement>) {
  event.preventDefault();event.currentTarget.querySelector<HTMLButtonElement>('.row-menu-trigger')?.click();
}
