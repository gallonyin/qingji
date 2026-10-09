import {t, useLocale} from '../lib/i18n';
import {memo,useMemo,useState,useLayoutEffect,useRef} from 'react';
import {ChevronDown,ChevronRight,Folder,FileText} from 'lucide-react';
import type {NoteSummary} from '../lib/db';
import {buildFolderTree,flattenFolders,isInFolder} from '../lib/folders';
const ROW_HEIGHT=28,OVERSCAN=5;
export const FolderTree=memo(function FolderTree({notes,selected,selectedNoteId,onSelect,onOpenNote,expanded:storedExpanded,onExpandedChange}:{notes:NoteSummary[];selected:string|null;selectedNoteId?:string;onSelect:(path:string)=>void;onOpenNote?:(note:NoteSummary,path:string)=>void;expanded?:Record<string,boolean>;onExpandedChange?:(value:Record<string,boolean>)=>void}) {
  const locale = useLocale();
  const model=useMemo(()=>buildFolderTree(notes),[notes]);
  const roots=useMemo(()=>model.unfiled?[...model.roots,{path:'',name:t("未分类"),count:model.unfiled,children:[],notes:model.unfiledNotes}]:model.roots,[model,locale]);
  const [localExpanded,setLocalExpanded]=useState<Record<string,boolean>>({});
  const expanded=storedExpanded??localExpanded;
  const setExpanded=(path:string,open:boolean)=>{
    const next={...expanded,[path]:open};
    if(onExpandedChange)onExpandedChange(next);else setLocalExpanded(next);
  };
  const rows=useMemo(()=>flattenFolders(roots,expanded,selected),[roots,expanded,selected]);
  const treeRef=useRef<HTMLDivElement>(null);
  const [top,setTop]=useState(0),[height,setHeight]=useState(200);
  useLayoutEffect(()=>{
    const element=treeRef.current!;
    const resize=()=>setHeight(element.clientHeight||200);
    resize();
    if(typeof ResizeObserver==='undefined')return;
    const observer=new ResizeObserver(resize);observer.observe(element);return()=>observer.disconnect();
  },[]);
  useLayoutEffect(()=>{
    const element=treeRef.current!;
    let index=selectedNoteId?rows.findIndex(row=>row.kind==='note'&&row.note.id===selectedNoteId):-1;
    if(index<0&&selected!==null)index=rows.findIndex(row=>row.kind==='folder'?row.node.path===selected:row.path===selected);
    if(index<0)return;
    const position=index*ROW_HEIGHT;
    if(position<element.scrollTop)element.scrollTop=position;
    else if(position+ROW_HEIGHT>element.scrollTop+height)element.scrollTop=position+ROW_HEIGHT-height;
    setTop(element.scrollTop);
  },[selected,selectedNoteId,roots,height]);
  useLayoutEffect(()=>{
    const maximum=Math.max(0,rows.length*ROW_HEIGHT-height);
    if(treeRef.current!.scrollTop>maximum){treeRef.current!.scrollTop=maximum;setTop(maximum);}
  },[rows.length,height]);
  const start=Math.max(0,Math.min(Math.floor(top/ROW_HEIGHT)-OVERSCAN,Math.max(0,rows.length-1)));
  const end=Math.min(rows.length,start+Math.ceil(height/ROW_HEIGHT)+OVERSCAN*2);
  return <section className="folder-section" aria-label={t("笔记目录")}>
    <div className="folder-heading">{t("目录")}<small>{t("数量含子目录")}</small></div>
    <div className="folder-tree" tabIndex={0} aria-label={t("笔记目录树")} ref={treeRef} onScroll={event=>setTop(event.currentTarget.scrollTop)} data-tree-rows={rows.length} data-selected-folder-notes={selected===null?undefined:rows.filter(row=>row.kind==='note'&&isInFolder(row.path,selected)).length}>
      <div style={{height:start*ROW_HEIGHT}} aria-hidden="true"/>
      {rows.slice(start,end).map(row=>{
        if(row.kind==='note'){
          const active=selectedNoteId?selectedNoteId===row.note.id:selected===row.path;
          return <div key={row.key} className={`folder-row note-tree-row ${active?'selected':''}`} style={{paddingLeft:8+row.depth*14}}>
            <span className="folder-toggle"/>
            <button className="folder-select" aria-label={t("笔记 {0}", row.note.title)} aria-current={active?'page':undefined} data-tooltip-mode="always" data-tooltip={t("笔记：{0}\n保存目录：{1}", row.note.title, row.path||t("未分类"))} onClick={()=>onOpenNote?onOpenNote(row.note,row.path):onSelect(row.path)}><FileText size={13}/><span>{row.note.title}</span></button>
          </div>;
        }
        const {node,open}=row;
        return <div key={row.key} className={`folder-row ${selected===node.path?'selected':''}`} style={{paddingLeft:8+row.depth*14}}>
          <button className="folder-toggle" aria-label={t("{0}目录 {1}", open?t("收起"):t("展开"), node.path||t("未分类"))} aria-expanded={open} onClick={()=>setExpanded(node.path,!open)}>{open?<ChevronDown size={13}/>:<ChevronRight size={13}/>}</button>
          <button className="folder-select" aria-label={t("目录 {0}", node.path||t("未分类"))} aria-current={selected===node.path?'page':undefined} data-tooltip-mode="always" data-tooltip={t("{0}（含子目录 {1} 篇）", node.path||t("未分类"), node.count)} onClick={()=>{setExpanded(node.path,true);onSelect(node.path);}}><Folder size={13}/><span>{node.name}</span><small>{node.count}</small></button>
        </div>;
      })}
      <div style={{height:(rows.length-end)*ROW_HEIGHT}} aria-hidden="true"/>
    </div>
  </section>;
});
