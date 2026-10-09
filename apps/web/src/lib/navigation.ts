export type NavigationState = {
  view:'all'|'favorites'|'recent'|'trash';
  folder:string|null;
  noteId:string;
  expanded:Record<string,boolean>;
};
export const emptyNavigation=():NavigationState=>({view:'all',folder:null,noteId:'',expanded:{}});
export function readNavigation(user:string):NavigationState {
  try {
    const raw=JSON.parse(localStorage.getItem('mynote:navigation:'+encodeURIComponent(user))??'null');
    if(!raw||typeof raw!=='object')return emptyNavigation();
    return {
      view:['all','favorites','recent','trash'].includes(raw.view)?raw.view:'all',
      folder:typeof raw.folder==='string'?raw.folder:null,
      noteId:typeof raw.noteId==='string'?raw.noteId:'',
      expanded:raw.expanded&&typeof raw.expanded==='object'&&!Array.isArray(raw.expanded)
        ?Object.fromEntries(Object.entries(raw.expanded).filter(([,value])=>typeof value==='boolean')) as Record<string,boolean>:{}
    };
  } catch { return emptyNavigation(); }
}
export function saveNavigation(user:string,state:NavigationState) {
  try { localStorage.setItem('mynote:navigation:'+encodeURIComponent(user),JSON.stringify(state)); }
  catch { /* Browsing remains usable when storage is disabled or full. */ }
}
