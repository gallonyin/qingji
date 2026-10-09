import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {beforeEach,afterEach,it,expect} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {buildApp} from '../src/app.js';
import {deserialize} from '../src/note-store.js';
let app:FastifyInstance,root:string,headers:Record<string,string>;
beforeEach(async()=>{
 root=await mkdtemp(path.join(os.tmpdir(),'qingji-review-'));
 app=await buildApp({dataDir:root,password:'test-password'});
 const auth=(await app.inject({method:'POST',url:'/auth/login',payload:{password:'test-password'}})).json();
 headers={authorization:`Bearer ${auth.token}`,'x-vault-epoch':auth.epoch};
});
afterEach(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
it('离线编辑后删除及恢复时，正文和状态在一个版本中提交，重启后不丢内容',async()=>{
 const original=await app.noteStore.create({title:'原文',content:'旧内容'});
 const push=async(change:Record<string,unknown>)=>{
  const reply=await app.inject({method:'POST',url:'/sync/push',headers,payload:{changes:[{id:original.id,operationId:crypto.randomUUID(),...change}]}});
  expect(reply.statusCode).toBe(200);return reply.json().results[0].note;
 };
 const deleted=await push({baseRevision:1,title:'离线标题',content:'离线改动',deleted:true});
 expect(deleted.revision).toBe(2);expect(deleted.content).toBe('离线改动');expect(deleted.deletedAt).toBeTruthy();expect(deleted).not.toHaveProperty('baseRevision');expect(deleted).not.toHaveProperty('operationId');
 const restored=await push({baseRevision:2,content:'恢复前的新正文',restored:true});expect(restored.revision).toBe(3);expect(restored.deletedAt).toBeNull();
 await app.close();app=await buildApp({dataDir:root,password:'test-password'});
 expect(app.noteStore.get(original.id)?.content).toBe('恢复前的新正文');
});
it('离线创建后删除的笔记首次同步进入回收站',async()=>{
 const id=crypto.randomUUID();const reply=await app.inject({method:'POST',url:'/sync/push',headers,payload:{changes:[{id,operationId:crypto.randomUUID(),baseRevision:0,title:'未上传就删除',content:'保留内容',deleted:true}]}});
 expect(reply.statusCode).toBe(200);expect(reply.json().results[0].note.deletedAt).toBeTruthy();expect(app.noteStore.list('active')).toHaveLength(0);expect(app.noteStore.list('trash')[0].content).toBe('保留内容');
});
it('导入的未知 frontmatter 在编辑后保留，正文换行保持原样',async()=>{
 const note=await app.noteStore.create({title:'导入元数据'});const filename=path.join(root,'notes',`${note.id}.md`);
 const raw=await readFile(filename,'utf8');await writeFile(filename,raw.replace('---\n','---\nsourceUrl: https://example.com/article\njoplinIsTodo: true\n'));
 await app.noteStore.scan(true);await app.noteStore.update(note.id,{content:'\n正文\n\n'},1);
 const parsed=deserialize(await readFile(filename,'utf8'));expect(parsed.content).toBe('\n正文\n\n');expect(parsed.extraFrontmatter).toEqual({sourceUrl:'https://example.com/article',joplinIsTodo:true});
});
it('拒绝可执行 frontmatter 和非法身份或版本',()=>{
 expect(()=>deserialize('---js\n(() => { throw new Error("executed") })()\n---\n')).toThrow('INVALID_NOTE_FRONTMATTER');
 expect(()=>deserialize('---\nid: ../../outside\nrevision: .nan\n---\nbody')).toThrow();
});
it('SVG 附件可读取但直接打开受到 sandbox 和 nosniff 隔离',async()=>{
 const note=await app.noteStore.create({title:'附件'});await app.noteStore.saveAttachment(note.id,'diagram.svg',Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
 const response=await app.inject({url:`/attachments/${note.id}/diagram.svg`,headers});expect(response.statusCode).toBe(200);expect(response.headers['content-security-policy']).toContain('sandbox');expect(response.headers['x-content-type-options']).toBe('nosniff');
});
it('登录频率受限，响应保留 429 与 retry-after',async()=>{
 for(let index=0;index<10;index++)expect((await app.inject({method:'POST',url:'/auth/login',remoteAddress:'198.51.100.10',payload:{password:'wrong'}})).statusCode).toBe(401);
 const blocked=await app.inject({method:'POST',url:'/auth/login',remoteAddress:'198.51.100.10',payload:{password:'test-password'}});expect(blocked.statusCode).toBe(429);expect(blocked.json().error).toBe('RATE_LIMITED');expect(blocked.headers['retry-after']).toBeTruthy();
 expect((await app.inject({method:'POST',url:'/auth/login',remoteAddress:'198.51.100.11',payload:{password:'test-password'}})).statusCode).toBe(200);
});
it('未认证请求不能读笔记、检索、同步、备份、导出和附件',async()=>{
 for(const url of ['/notes','/search?q=test','/sync/state','/sync/pull','/backups/status','/backups/observability','/export',`/attachments/${crypto.randomUUID()}/test.svg`])expect((await app.inject({url})).statusCode).toBe(401);
});
