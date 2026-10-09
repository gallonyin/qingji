import {mkdtemp,rm,readFile,stat,writeFile} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {buildApp} from '../src/app.js';
import {testS3,environmentSettings,type S3Settings} from '../src/settings.js';
let root:string,app:FastifyInstance,headers:Record<string,string>;
const objects=new Map<string,Buffer>();
const transport={send:vi.fn(async(command:any)=>{
 const {Key,Body,Delete}=command.input;
 if(command.constructor.name==='PutObjectCommand')objects.set(Key,Buffer.from(Body));
 if(command.constructor.name==='GetObjectCommand')return {Body:{transformToByteArray:async()=>objects.get(Key)}};
 if(command.constructor.name==='DeleteObjectsCommand')for(const o of Delete.Objects)objects.delete(o.Key);
 return {};
})};
beforeEach(async()=>{root=await mkdtemp(path.join(os.tmpdir(),'qingji-settings-'));objects.clear();transport.send.mockClear();app=await buildApp({dataDir:root,password:'test-password',settingsTransport:()=>transport});const token=(await app.inject({method:'POST',url:'/auth/login',payload:{password:'test-password'}})).json().token;headers={authorization:`Bearer ${token}`};});
afterEach(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
const current=async()=> (await app.inject({url:'/settings',headers})).json();
const save=async(value:any)=>app.inject({method:'PUT',url:'/settings',headers,payload:value});
it('品牌公开、配置受认证保护且不能读到密钥',async()=>{
 expect((await app.inject({url:'/branding'})).json()).toMatchObject({name:'轻记',logoText:'记',githubUrl:'https://github.com/gallonyin/qingji'});
 expect((await app.inject({url:'/settings'})).statusCode).toBe(401);
 const value=await current();value.s3={...value.s3,accessKeyId:'fixture-access',secretAccessKey:'fixture-secret',bucket:'test-bucket'};
 const reply=await save(value);expect(reply.statusCode).toBe(200);expect(reply.body).not.toContain('fixture-');expect(reply.json().s3).toMatchObject({accessKeyId:'',secretAccessKey:'',hasSecretKey:true});
 expect((await app.inject({url:'/branding'})).body).not.toContain('fixture-');
 expect((await stat(path.join(root,'settings.json'))).mode&0o777).toBe(0o600);
});
it('设置重启保留，空密钥保留原值，旧 revision 不覆盖新配置',async()=>{
 const value=await current();value.branding.name='我的书桌';value.s3.accessKeyId='fixture-access';value.s3.secretAccessKey='fixture-secret';
 expect((await save(value)).statusCode).toBe(200);expect((await save(value)).statusCode).toBe(409);
 const next=await current();next.branding.logoText='书';expect((await save(next)).statusCode).toBe(200);
 await app.close();app=await buildApp({dataDir:root,password:'test-password',settingsTransport:()=>transport});
 expect((await app.inject({url:'/branding'})).json()).toMatchObject({name:'我的书桌',logoText:'书'});
 const stored=JSON.parse(await readFile(path.join(root,'settings.json'),'utf8'));expect(stored.s3.secretAccessKey).toBe('fixture-secret');
});
it('测试未保存配置，读写校验后清理自己的对象，默认不开启备份',async()=>{
 const value=await current();const s3={...value.s3,enabled:false,bucket:'test-bucket',accessKeyId:'fixture-access',secretAccessKey:'fixture-secret'};
 const result=await app.inject({method:'POST',url:'/settings/s3/test',headers,payload:s3});expect(result.json()).toMatchObject({ok:true,stage:'complete'});
 expect(transport.send.mock.calls.map(([command])=>command.constructor.name)).toEqual(['ListObjectsV2Command','PutObjectCommand','GetObjectCommand','DeleteObjectsCommand']);expect(objects.size).toBe(0);
 expect((await current()).revision).toBe(0);expect((await app.inject({url:'/backups/status',headers})).json().configured).toBe(false);
});
it('启用、关闭与清除密钥实时生效，自动备份规则更新',async()=>{
 let value=await current();value.s3={...value.s3,enabled:true,scheduleEnabled:true,bucket:'test-bucket',accessKeyId:'fixture-access',secretAccessKey:'fixture-secret',debounceSeconds:300,maxWaitSeconds:600};
 expect((await save(value)).statusCode).toBe(200);
 const status=(await app.inject({url:'/backups/status',headers})).json();expect(status).toMatchObject({configured:true,scheduleEnabled:true,automation:{debounceSeconds:300}});
 value=await current();value.s3.enabled=false;value.s3.scheduleEnabled=false;
 expect((await save({...value,clearCredentials:true})).statusCode).toBe(200);
 expect((await current()).s3.hasSecretKey).toBe(false);expect((await app.inject({url:'/backups/status',headers})).json().configured).toBe(false);
});
it('保护期间可改外观但不能切换 S3 目标，且失败不写配置',async()=>{
 await writeFile(path.join(root,'.backup-protection.json'),JSON.stringify({phase:'downloading',snapshotId:'sample'}));
 const value=await current();value.branding.name='外观更新';expect((await save(value)).statusCode).toBe(200);
 const next=await current();next.s3.bucket='new-bucket';expect((await save(next)).statusCode).toBe(409);expect((await current()).s3.bucket).toBe('');
});
it('输入校验拒绝脚本 Logo、非法 Endpoint、缺失密钥和不合法自动时序',async()=>{
 for(const patch of [{branding:{name:'',logoText:'记',logoImage:''}},{branding:{name:'应用',logoText:'记',logoImage:'data:image/svg+xml;base64,PHN2Zz4='}},{s3:{endpoint:'file:///etc/passwd'}},{s3:{enabled:true}},{s3:{debounceSeconds:100,maxWaitSeconds:10}}]){
  const value=await current();const body={...value,branding:{...value.branding,...patch.branding},s3:{...value.s3,...patch.s3}};
  expect((await save(body)).statusCode).toBe(400);
 }
 expect((await current()).revision).toBe(0);
});
it('权限错误脱敏、读取校验失败和清理失败不误报成功',async()=>{
 const s3:S3Settings={...environmentSettings().s3,bucket:'test-bucket',accessKeyId:'fixture-access',secretAccessKey:'fixture-secret'};
 const denied={send:vi.fn().mockRejectedValue(Object.assign(new Error('contains-secret'),{$metadata:{httpStatusCode:403}}))};
 const failure=await testS3(s3,denied);expect(failure).toMatchObject({ok:false,stage:'list',code:'ACCESS_DENIED'});expect(JSON.stringify(failure)).not.toContain('contains-secret');
 const corrupt={send:vi.fn(async(command:any)=>command.constructor.name==='GetObjectCommand'?{Body:{transformToByteArray:async()=>Buffer.from('bad')}}:{})};
 expect(await testS3(s3,corrupt)).toMatchObject({ok:false,code:'CONTENT_MISMATCH'});expect(corrupt.send.mock.calls.at(-1)?.[0].constructor.name).toBe('DeleteObjectsCommand');
 const cleanup={send:vi.fn(async(command:any)=>command.constructor.name==='DeleteObjectsCommand'?{Errors:[{Code:'AccessDenied'}]}:command.constructor.name==='GetObjectCommand'?{Body:{transformToByteArray:async()=>Buffer.from('bad')}}:{})};
 await expect(testS3(s3,cleanup)).rejects.toThrow('S3_TEST_CLEANUP_FAILED');
});
it('真实 SDK 通过本地 S3 HTTP 接口完成签名请求和读写删除',async()=>{
 const {createServer}=await import('node:http');const {s3Transport}=await import('../src/settings.js');
 const wireObjects=new Map<string,Buffer>();const methods:string[]=[];const signed:boolean[]=[];
 const server=createServer(async(request,response)=>{
  methods.push(request.method!);signed.push(request.headers.authorization?.includes('Credential=fixture-access/')??false);
  const url=new URL(request.url!,'http://localhost'),chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
  if(request.method==='PUT'){wireObjects.set(url.pathname,Buffer.concat(chunks));response.end();}
  else if(request.method==='GET'&&url.searchParams.has('list-type')){response.setHeader('Content-Type','application/xml');response.end('<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>test-bucket</Name><KeyCount>0</KeyCount><IsTruncated>false</IsTruncated></ListBucketResult>');}
  else if(request.method==='GET'){const data=wireObjects.get(url.pathname)!;response.setHeader('Content-Length',data.length);response.end(data);}
  else if(request.method==='POST'&&url.searchParams.has('delete')){wireObjects.clear();response.setHeader('Content-Type','application/xml');response.end('<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>');}
  else{response.statusCode=400;response.end();}
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as import('node:net').AddressInfo).port;
 const s3:S3Settings={...environmentSettings().s3,endpoint:`http://127.0.0.1:${port}`,region:'us-east-1',bucket:'test-bucket',accessKeyId:'fixture-access',secretAccessKey:'fixture-secret',forcePathStyle:true,serverSideEncryption:'none'};
 const client=s3Transport(s3);
 try{expect(await testS3(s3,client)).toMatchObject({ok:true});expect(methods).toEqual(['GET','PUT','GET','POST']);expect(signed.every(Boolean)).toBe(true);expect(wireObjects.size).toBe(0);}
 finally{client.destroy();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
it('后台备份运行时禁止改配置，失败后设置版本与原目标保持不变',async()=>{
 const value=await current();value.s3={...value.s3,enabled:true,bucket:'test-bucket',accessKeyId:'fixture-access',secretAccessKey:'fixture-secret'};
 expect((await save(value)).statusCode).toBe(200);
 let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
 transport.send.mockImplementationOnce(async()=>{await gate;return {};});
 try{
  expect((await app.inject({method:'POST',url:'/backups',headers,payload:{reason:'manual'}})).statusCode).toBe(202);
  const next=await current();next.s3.bucket='different-bucket';const response=await save(next);
  expect(response.statusCode).toBe(409);expect(response.json().error).toBe('S3_BACKUP_BUSY');expect((await current()).s3.bucket).toBe('test-bucket');
 }finally{release();}
});
it('自定义品牌用于 manifest 和图标，SVG 文字会转义且不泄露配置',async()=>{
 const value=await current();value.branding={name:'我的工作台',logoText:'<script>',logoImage:''};expect((await save(value)).statusCode).toBe(200);
 const manifest=await app.inject({url:'/branding/manifest'});expect(manifest.json()).toMatchObject({name:'我的工作台',icons:[{src:'icon'}]});expect(manifest.headers['cache-control']).toBe('no-cache');
 const icon=await app.inject({url:'/branding/icon'});expect(icon.headers['content-type']).toContain('image/svg+xml');expect(icon.body).toContain('&lt;script&gt;');expect(icon.body).not.toContain('<script>');
});
it('配置文件已保存但调度标记未提交的重启，仍能识别新目标并建立备份基线',async()=>{
 const value=await current();value.s3={...value.s3,enabled:true,bucket:'old-bucket',accessKeyId:'fixture-access',secretAccessKey:'fixture-secret'};expect((await save(value)).statusCode).toBe(200);
 await app.close();
 const {MetadataDatabase}=await import('../src/database.js');const metadata=new MetadataDatabase(path.join(root,'metadata.sqlite'));metadata.backupSucceeded(metadata.backupScheduleState().revision);metadata.close();
 const filename=path.join(root,'settings.json'),stored=JSON.parse(await readFile(filename,'utf8'));stored.s3.bucket='new-bucket';await writeFile(filename,JSON.stringify(stored));
 app=await buildApp({dataDir:root,password:'test-password',settingsTransport:()=>transport});
 expect((await current()).s3.bucket).toBe('new-bucket');expect((await app.inject({url:'/backups/status',headers})).json().automation).toMatchObject({pendingChanges:1,lastSuccessAt:null});
});
