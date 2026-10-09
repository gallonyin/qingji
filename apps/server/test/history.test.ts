import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {buildApp} from '../src/app.js';
import type {FastifyInstance} from 'fastify';

let app:FastifyInstance,root:string,headers:Record<string,string>;
beforeEach(async()=>{root=await mkdtemp(path.join(os.tmpdir(),'mynote-history-'));app=await buildApp({dataDir:root,password:'test'});const login=(await app.inject({method:'POST',url:'/auth/login',payload:{password:'test'}})).json();headers={authorization:`Bearer ${login.token}`,'x-vault-epoch':login.epoch};});
afterEach(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
async function create(){return (await app.inject({method:'POST',url:'/notes',headers,payload:{title:'版本一',content:'\n正文一\n',folder:'原目录',tags:['旧标签']}})).json().note;}
async function patch(id:string,revision:number,content:string){const r=await app.inject({method:'PATCH',url:`/notes/${id}`,headers,payload:{revision,content,title:'版本二',folder:'新目录',tags:['新标签']}});expect(r.statusCode).toBe(200);return r.json().note;}
async function history(id:string,query=''){return (await app.inject({url:`/notes/${id}/history${query}`,headers})).json();}

it('分页预览历史，恢复产生新版本并保留恢复前内容，重启仍可找回',async()=>{
 const note=await create();await patch(note.id,1,'正文二');
 const page=await history(note.id,'?limit=1');expect(page.versions[0].revision).toBe(2);expect(page.hasMore).toBe(true);
 const older=await history(note.id,`?before=${page.versions[0].id}`);const id=older.versions[0].id;
 expect((await app.inject({url:`/notes/${note.id}/history/${id}`,headers})).json().note.content).toBe('\n正文一\n');
 const restored=await app.inject({method:'POST',url:`/notes/${note.id}/history/${id}/restore`,headers,payload:{revision:2}});
 expect(restored.statusCode).toBe(200);expect(restored.json().note).toMatchObject({id:note.id,revision:3,title:'版本一',content:'\n正文一\n',folder:'原目录',tags:['旧标签'],createdAt:note.createdAt});
 await app.close();app=await buildApp({dataDir:root,password:'test'});
 expect((await history(note.id)).versions.map((v:any)=>v.revision)).toEqual([3,2,1]);
 expect((await app.inject({url:`/notes/${note.id}/history/${page.versions[0].id}`,headers})).json().note.content).toBe('正文二');
});
it('恢复拒绝陈旧版本、跨笔记历史 ID 和旧 epoch；不静默覆盖并发修改',async()=>{
 const note=await create();const id=(await history(note.id)).versions[0].id;await patch(note.id,1,'新修改');
 const request={method:'POST' as const,url:`/notes/${note.id}/history/${id}/restore`,headers,payload:{revision:1}};
 expect((await app.inject(request)).statusCode).toBe(409);
 const other=await create();expect((await app.inject({...request,url:`/notes/${other.id}/history/${id}/restore`})).statusCode).toBe(404);
 expect((await app.inject({...request,headers:{...headers,'x-vault-epoch':'old'},payload:{revision:2}})).statusCode).toBe(409);
 const results=await Promise.all([app.inject({...request,payload:{revision:2}}),app.inject({...request,payload:{revision:2}})]);
 expect(results.map(r=>r.statusCode).sort()).toEqual([200,409]);expect((await history(note.id)).versions).toHaveLength(3);
});
it('重建索引保留历史，永久删除清除历史且重启不重新导入',async()=>{
 const note=await create();const id=(await history(note.id)).versions[0].id;await patch(note.id,1,'第二版');
 await app.inject({method:'POST',url:'/scan',headers});headers['x-vault-epoch']=(await app.inject({url:'/sync/state',headers})).json().epoch;
 expect((await app.inject({url:`/notes/${note.id}/history/${id}`,headers})).statusCode).toBe(200);
 await app.inject({method:'DELETE',url:`/notes/${note.id}?revision=2`,headers});
 expect((await app.inject({method:'POST',url:`/notes/${note.id}/history/${id}/restore`,headers,payload:{revision:3}})).json().error).toBe('NOTE_IN_TRASH');
 await app.inject({method:'DELETE',url:`/notes/${note.id}/permanent?revision=3`,headers});
 await app.close();app=await buildApp({dataDir:root,password:'test'});
 expect((await app.inject({url:`/notes/${note.id}/history`,headers})).statusCode).toBe(404);
});

it('旧数据库中的版本升级导入一次，历史预览正文保真',async()=>{
 const note=await create();await patch(note.id,1,'第二版');await app.close();
 const {MetadataDatabase}=await import('../src/database.js');
 const metadata=new MetadataDatabase(path.join(root,'metadata.sqlite'));
 metadata.db.exec("DROP TABLE note_history; DELETE FROM vault_state WHERE key='history_migrated';");metadata.close();
 app=await buildApp({dataDir:root,password:'test'});
 const first=await history(note.id);expect(first.versions).toHaveLength(2);
 await app.close();app=await buildApp({dataDir:root,password:'test'});
 expect((await history(note.id)).versions.map((v:any)=>v.id)).toEqual(first.versions.map((v:any)=>v.id));
 const older=first.versions.find((v:any)=>v.revision===1);
 expect((await app.inject({url:`/notes/${note.id}/history/${older.id}`,headers})).json().note.content).toBe('\n正文一\n');
});
