import type {NoteSummary} from './db';
export type FolderNode = {path:string;name:string;count:number;children:FolderNode[];notes:NoteSummary[]};
export function isInFolder(parentId:string|null, path:string) {
  return path === '' ? !parentId : parentId === path || !!parentId?.startsWith(path+'/');
}
/** Derive hierarchy from stored paths without reading any note bodies. */
export function buildFolderTree(notes:readonly NoteSummary[], paths:readonly string[] = []) {
  const roots:FolderNode[]=[];
  const nodes=new Map<string,FolderNode>();
  const unfiledNotes:NoteSummary[]=[];
  let unfiled=0;
  for(const note of notes) {
    if(note.deletedAt)continue;
    if(!note.parentId){unfiled++;unfiledNotes.push(note);continue;}
    const parts=note.parentId.split('/');
    let siblings=roots;
    for(let i=0;i<parts.length;i++) {
      const path=parts.slice(0,i+1).join('/');
      let node=nodes.get(path);
      if(!node){node={path,name:parts[i],count:0,children:[],notes:[]};nodes.set(path,node);siblings.push(node);}
      node.count++;
      if(i===parts.length-1)node.notes.push(note);
      siblings=node.children;
    }
  }
  for(const folder of paths) {
    let siblings=roots;
    const parts=folder.split('/');
    for(let i=0;i<parts.length;i++) {
      const path=parts.slice(0,i+1).join('/');
      let node=nodes.get(path);
      if(!node){node={path,name:parts[i],count:0,children:[],notes:[]};nodes.set(path,node);siblings.push(node);}
      siblings=node.children;
    }
  }
  const sort=(children:FolderNode[])=>{children.sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'));children.forEach(node=>sort(node.children));};
  sort(roots);
  return {roots,unfiled,unfiledNotes};
}

export type FolderRow = {kind:'folder';node:FolderNode;depth:number;open:boolean;key:string} | {kind:'note';note:NoteSummary;path:string;depth:number;key:string};
export function flattenFolders(roots:FolderNode[],expanded:Record<string,boolean>,selected:string|null):FolderRow[] {
  const rows:FolderRow[]=[];
  const visit=(node:FolderNode,depth:number)=>{
    const open=expanded[node.path]??((depth===0&&node.children.length>0)||selected===node.path||!!selected?.startsWith(node.path+'/'));
    rows.push({kind:'folder',node,depth,open,key:'f:'+node.path});
    if(open){
      node.children.forEach(child=>visit(child,depth+1));
      node.notes.forEach(note=>rows.push({kind:'note',note,path:node.path,depth:depth+1,key:'n:'+note.id}));
    }
  };
  roots.forEach(root=>visit(root,0));
  return rows;
}
