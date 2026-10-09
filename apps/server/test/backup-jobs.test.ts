import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe,it,expect,vi} from 'vitest';
import {BackupJobs} from '../src/backup-jobs.js';
import {WriteQueue} from '../src/write-queue.js';
import type {BackupService} from '../src/backup-service.js';

const service=(action:()=>Promise<any>)=>({status:()=>({configured:true,progress:{phase:'downloading'}}),restore:action,createSnapshot:action}) as unknown as BackupService;
describe('persistent backup jobs',()=>{
 it('任务先返回，完成结果写盘；不会同时启动第二个任务',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'mynote-jobs-'));
  let release!:()=>void;
  const block=new Promise<void>(r=>release=r);
  const jobs=new BackupJobs(dir,service(async()=>{await block;return{id:'snapshot'};}),new WriteQueue());
  try{
   await jobs.initialize();const job=await jobs.create('backup');expect(['queued','running']).toContain(job.state);
   await expect(jobs.create('restore','snapshot')).rejects.toThrow('S3_BACKUP_BUSY');
   release();await jobs.close();
   const saved=JSON.parse(await readFile(path.join(dir,'backup-jobs.json'),'utf8'));
   expect(saved[0]).toMatchObject({state:'succeeded',snapshotId:'snapshot'});
  }finally{release();await jobs.close();await rm(dir,{recursive:true,force:true});}
 });
 it('重启读取运行中任务并续跑，失败不会自动无限重试',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'mynote-jobs-'));
  await writeFile(path.join(dir,'backup-jobs.json'),JSON.stringify([{id:'old',kind:'restore',snapshotId:'snap',state:'running'}]));
  const action=vi.fn().mockRejectedValue(new Error('DISK_FULL'));
  const jobs=new BackupJobs(dir,service(action),new WriteQueue());
  try{await jobs.initialize();await jobs.close();expect(action).toHaveBeenCalledOnce();expect(jobs.list()[0]).toMatchObject({state:'failed',error:'DISK_FULL'});}
  finally{await rm(dir,{recursive:true,force:true});}
 });
});
