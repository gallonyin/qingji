import {t, useLocale, getLocale} from '../lib/i18n';
import {memo, useLayoutEffect, useRef, useState} from 'react';
import {FileText,Heart} from 'lucide-react';
import type {NoteSummary} from '../lib/db';

const ROW_HEIGHT=58, OVERSCAN=6;

function Mark({text,query}:{text:string;query:string}){
  const at=query?text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()):-1;
  return at<0?<>{text}</>:<>{text.slice(0,at)}<mark>{text.slice(at,at+query.length)}</mark>{text.slice(at+query.length)}</>;
}
const Row=memo(function Row({note,selected,query,onOpen}:{note:NoteSummary;selected:boolean;query:string;onOpen:(note:NoteSummary)=>void}){
  useLocale();
 return <button className={`note-row ${selected?'selected':''}`} data-tooltip-overflow=".note-title, .note-excerpt" data-tooltip={`${note.title}\n${note.excerpt||t("空白笔记")}`} aria-current={selected?'page':undefined} onClick={()=>onOpen(note)}>
  <span className="note-title" data-tooltip={note.title}><FileText className="note-file-icon" size={13} aria-hidden="true"/>{note.favorite&&<Heart size={11} fill="currentColor"/>}<Mark text={note.title} query={query}/></span>
  <span className="note-excerpt" data-tooltip={note.excerpt||t("空白笔记")}><Mark text={note.excerpt||t("空白笔记")} query={query}/></span>
  <time>{new Intl.DateTimeFormat(getLocale(),{month:'numeric',day:'numeric'}).format(note.updatedAt)}</time>
 </button>;
});
/** Only mount the visible rows; scrolling never parses the whole vault's content. */
export const NoteList=memo(function NoteList({notes,selectedId,query,resetKey,onOpen}:{notes:NoteSummary[];selectedId:string;query:string;resetKey:string;onOpen:(note:NoteSummary)=>void}){
  useLocale();
 const host=useRef<HTMLDivElement>(null);
 const [top,setTop]=useState(0),[height,setHeight]=useState(600);
 useLayoutEffect(()=>{
  const element=host.current!;
  const resize=()=>setHeight(element.clientHeight||600);
  resize();const observer=new ResizeObserver(resize);observer.observe(element);return ()=>observer.disconnect();
 },[]);
 useLayoutEffect(()=>{host.current!.scrollTop=0;setTop(0);},[resetKey]);
 useLayoutEffect(()=>{
  const index=notes.findIndex(note=>note.id===selectedId);
  if(index<0)return;
  const element=host.current!,position=index*ROW_HEIGHT;
  if(position<element.scrollTop)element.scrollTop=position;
  else if(position+ROW_HEIGHT>element.scrollTop+height)element.scrollTop=position+ROW_HEIGHT-height;
  setTop(element.scrollTop);
 },[selectedId,resetKey,height,notes.length]);
 const start=Math.max(0,Math.min(Math.floor(top/ROW_HEIGHT)-OVERSCAN,Math.max(0,notes.length-1)));
 const end=Math.min(notes.length,start+Math.ceil(height/ROW_HEIGHT)+OVERSCAN*2);
 return <div className="note-list" ref={host} onScroll={event=>setTop(event.currentTarget.scrollTop)} onKeyDown={event=>{
  if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key)||!notes.length)return;
  event.preventDefault();const current=notes.findIndex(n=>n.id===selectedId);
  const index=event.key==='Home'?0:event.key==='End'?notes.length-1:Math.max(0,Math.min(notes.length-1,current+(event.key==='ArrowDown'?1:-1)));
  const position=index*ROW_HEIGHT,element=host.current!;
  if(position<element.scrollTop)element.scrollTop=position;
  else if(position+ROW_HEIGHT>element.scrollTop+height)element.scrollTop=position+ROW_HEIGHT-height;
  setTop(element.scrollTop);onOpen(notes[index]);
 }}>
  <div style={{height:start*ROW_HEIGHT}} aria-hidden="true"/>
  {notes.slice(start,end).map(note=><Row key={note.id} note={note} selected={selectedId===note.id} query={query} onOpen={onOpen}/>)}
  <div style={{height:(notes.length-end)*ROW_HEIGHT}} aria-hidden="true"/>
  {!notes.length&&<p className="empty">{t("这里还没有留下字迹。")}</p>}
 </div>;
});
