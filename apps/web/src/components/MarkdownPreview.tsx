import {memo} from 'react';
import ReactMarkdown,{defaultUrlTransform} from 'react-markdown';
import remarkGfm from 'remark-gfm';

function wikiTarget(href:string){try{return decodeURIComponent(href.slice(7));}catch{return href.slice(7);}}

// Sync status and list selection bookkeeping must not reparse an unchanged article.
export const MarkdownPreview=memo(function MarkdownPreview({content,onNavigate}:{content:string;onNavigate:(title:string)=>void}){
 return <article className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={(url,key)=>key==='href'&&url.startsWith('mynote:')?url:defaultUrlTransform(url)} components={{
  a:({href,children})=>href?.startsWith('mynote:')
   ?<button className="wiki-link" onClick={()=>onNavigate(wikiTarget(href))}>{children}</button>
   :<a href={href} target="_blank" rel="noreferrer">{children}</a>,
  img:({node:_,...props})=><img {...props} loading="lazy" decoding="async"/>
 }}>{content.replace(/\[\[([^\]]+)\]\]/g,'[$1](mynote:$1)')}</ReactMarkdown></article>;
});
