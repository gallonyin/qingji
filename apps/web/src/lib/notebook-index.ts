import type {Note} from './db';
export const linksIn=(content:string)=>[...new Set(Array.from(content.matchAll(/\[\[([^\]]+)\]\]/g),m=>m[1]))];
export function matchesNote(note:Note,query:string){
 return !query||`${note.title}\n${note.content}\n${note.tags.join(' ')}\n${note.parentId??''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}
export type IndexRequest=
 |{type:'refresh';reset:boolean;upserts:{id:string;indexToken:string}[];removed:string[]}
 |{type:'query';sequence:number;query:string;title:string};
export type IndexResponse={sequence:number;matches:string[];backlinks:string[];pending:number;total:number;reads:number;error?:string};
