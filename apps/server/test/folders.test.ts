import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {buildApp} from '../src/app.js';
import type {FastifyInstance} from 'fastify';
let app:FastifyInstance,root:string,headers:Record<string,string>;
beforeEach(async()=>{
  root=await mkdtemp(path.join(os.tmpdir(),'qingji-folders-'));
  app=await buildApp({dataDir:root,password:'test-password'});
  const login=(await app.inject({method:'POST',url:'/auth/login',payload:{password:'test-password'}})).json();
  headers={authorization:`Bearer ${login.token}`,'x-vault-epoch':login.epoch};
});
afterEach(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
async function folders(){return (await app.inject({url:'/folders',headers})).json();}
async function change(action:string,folder:string,extra:Record<string,unknown>={}){
  return app.inject({method:'POST',url:'/folders',headers,payload:{action,path:folder,revision:(await folders()).revision,...extra}});
}
async function note(folder:string){return (await app.inject({method:'POST',url:'/notes',headers,payload:{title:folder,content:'body\nunchanged',folder}})).json().note;}
it('empty folders survive restart, sync state and portable backup registry include ancestors',async()=>{
  expect((await change('create','Work/Empty')).statusCode).toBe(200);
  expect((await folders()).paths).toEqual(['Work','Work/Empty']);
  expect((await app.inject({url:'/sync/state',headers})).json().folders).toEqual(['Work','Work/Empty']);
  expect(JSON.parse(await readFile(path.join(root,'notes/.qingji-folders.json'),'utf8')).paths).toContain('Work/Empty');
  await app.close();app=await buildApp({dataDir:root,password:'test-password'});
  expect((await folders()).paths).toContain('Work/Empty');
});
it('moves nested folders and notes, protects similar prefixes, and publishes note history and sync',async()=>{
  const a=await note('Work/Deep'),b=await note('Workshop');
  await change('create','Work/Empty');
  const moved=await change('move','Work',{destination:'Archive/Work'});
  expect(moved.statusCode).toBe(200);
  expect(moved.json().paths).toEqual(['Archive','Archive/Work','Archive/Work/Deep','Archive/Work/Empty','Workshop']);
  const current=(await app.inject({url:`/notes/${a.id}`,headers})).json().note;
  expect(current.folder).toBe('Archive/Work/Deep');expect(current.content).toBe(a.content);expect(current.revision).toBe(a.revision+1);
  expect((await app.inject({url:`/notes/${b.id}`,headers})).json().note.folder).toBe('Workshop');
  expect((await app.inject({url:`/notes/${a.id}/history`,headers})).json().versions).toHaveLength(2);
  expect((await app.inject({url:'/sync/pull',headers})).json().changes.some((c:any)=>c.note?.folder==='Archive/Work/Deep')).toBe(true);
});
it('deletes a subtree to recoverable trash, leaves neighbouring folder alone and restores original location',async()=>{
  const a=await note('Work/Deep'),b=await note('Workshop');await change('create','Work/Empty');
  expect((await change('delete','Work',{expectedCount:2})).statusCode).toBe(409);
  const result=await change('delete','Work',{expectedCount:1});expect(result.statusCode).toBe(200);
  expect(result.json().paths).toEqual(['Workshop']);
  const trashed=(await app.inject({url:`/notes/${a.id}`,headers})).json().note;expect(trashed.deletedAt).toBeTruthy();expect(trashed.content).toBe(a.content);
  expect((await app.inject({url:`/notes/${b.id}`,headers})).json().note.deletedAt).toBeNull();
  expect((await app.inject({method:'POST',url:`/notes/${a.id}/restore`,headers,payload:{revision:trashed.revision}})).statusCode).toBe(200);
  expect((await folders()).paths).toEqual(['Work','Work/Deep','Workshop']);
});
it('rejects traversal, invalid and descendant moves, existing destination and stale revision',async()=>{
  expect((await change('create','../escape')).statusCode).toBe(400);
  await change('create','Work/Deep');await change('create','Other');
  expect((await change('move','Work',{destination:'Work/Deep/New'})).statusCode).toBe(400);
  expect((await change('move','Work',{destination:'Other'})).statusCode).toBe(409);
  const old=(await folders()).revision;await note('Work');
  expect((await app.inject({method:'POST',url:'/folders',headers,payload:{action:'delete',path:'Work',revision:old,expectedCount:0}})).statusCode).toBe(409);
  expect((await app.inject({method:'POST',url:'/folders',headers:{authorization:headers.authorization},payload:{action:'create',path:'New',revision:(await folders()).revision}})).statusCode).toBe(409);
});
it('restart finishes interrupted folder batch exactly once without losing body or history',async()=>{
  const a=await note('Work'),b=await note('Work/Deep');
  const changes=[a,b].map(n=>({oldFolder:n.folder,kind:'upsert',note:{...n,folder:'Archive/'+n.folder,revision:n.revision+1}}));
  await app.close();
  await writeFile(path.join(root,'.qingji-folder-operation.json'),JSON.stringify({paths:['Archive/Work','Archive/Work/Deep'],changes}));
  app=await buildApp({dataDir:root,password:'test-password'});
  for(const n of [a,b]){
    const current=(await app.inject({url:`/notes/${n.id}`,headers})).json().note;
    expect(current.content).toBe(n.content);expect(current.revision).toBe(2);expect(current.folder).toBe('Archive/'+n.folder);
  }
  await app.close();app=await buildApp({dataDir:root,password:'test-password'});
  expect((await app.inject({url:`/notes/${a.id}/history`,headers})).json().versions).toHaveLength(2);
});
