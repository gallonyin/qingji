// Run the actual worker script with isolated platform doubles to verify cache policy.
// Browser installation/offline navigation also require integration verification.
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {it,expect,vi} from 'vitest';
function worker(){
 const handlers:Record<string,Function>={};const entries=new Map<string,Response>();
 const key=(request:string|{url:string})=>typeof request==='string'?request:new URL(request.url).pathname;
 const cache={match:vi.fn(async(request:string|{url:string})=>entries.get(key(request))?.clone()),put:vi.fn(async(request:string|{url:string},response:Response)=>{entries.set(key(request),response)}),addAll:vi.fn(async()=>{})};
 const caches={open:vi.fn(async()=>cache),keys:vi.fn(async()=>['other-app-cache','mynote-shell-v1','mynote-shell-v2']),delete:vi.fn(async()=>true)};
 const fetch=vi.fn(async()=>new Response('fresh'));const claim=vi.fn(async()=>{});
 runInNewContext(readFileSync('public/sw.js','utf8'),{self:{addEventListener:(name:string,callback:Function)=>handlers[name]=callback,location:{origin:'http://localhost'},clients:{claim},skipWaiting:vi.fn()},caches,fetch,URL,Response});
 const request=async(path:string,navigate=false)=>{
  let result:Promise<Response>|undefined;const waits:Promise<unknown>[]=[];
  handlers.fetch({request:{method:'GET',url:`http://localhost${path}`,mode:navigate?'navigate':'cors'},waitUntil:(job:Promise<unknown>)=>waits.push(job),respondWith:(job:Promise<Response>)=>result=job});
  const response=await result;await Promise.all(waits);return response;
 };
 return {handlers,cache,caches,fetch,claim,entries,request};
}
it('activation only removes older Qingji caches',async()=>{
 const w=worker();let job:Promise<unknown>;w.handlers.activate({waitUntil:(value:Promise<unknown>)=>job=value});await job!;
 expect(w.caches.delete).toHaveBeenCalledExactlyOnceWith('mynote-shell-v1');expect(w.claim).toHaveBeenCalledOnce();
});
it('offline HTML fallback applies to navigation only; APIs are untouched',async()=>{
 const w=worker();w.entries.set('/index.html',new Response('shell'));w.fetch.mockRejectedValue(new Error('offline'));
 expect(await (await w.request('/note',true))?.text()).toBe('shell');expect((await w.request('/assets/missing.js'))?.type).toBe('error');
 expect(await w.request('/api/notes')).toBeUndefined();expect(await w.request('/attachments/private.png')).toBeUndefined();
});
it('failed responses do not replace a cached page and hashed assets avoid network',async()=>{
 const w=worker();w.entries.set('/index.html',new Response('shell'));w.fetch.mockResolvedValue(new Response('failure',{status:500}));
 expect(await (await w.request('/index.html',true))?.text()).toBe('shell');expect(w.cache.put).not.toHaveBeenCalled();
 w.entries.set('/assets/app-hash.js',new Response('code'));w.fetch.mockClear();expect(await (await w.request('/assets/app-hash.js'))?.text()).toBe('code');expect(w.fetch).not.toHaveBeenCalled();
});
it('successful HTML is refreshed and quota errors do not break a response',async()=>{
 const w=worker();w.cache.put.mockRejectedValue(new Error('quota'));expect(await (await w.request('/index.html',true))?.text()).toBe('fresh');
 expect(w.cache.put).toHaveBeenCalledOnce();
});
