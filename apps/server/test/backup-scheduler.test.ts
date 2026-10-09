import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {MetadataDatabase} from '../src/database.js';
import {BackupScheduler} from '../src/backup-scheduler.js';
import type {BackupJobs} from '../src/backup-jobs.js';
import type {BackupService} from '../src/backup-service.js';

describe('durable change-triggered backup',()=>{
 let root:string,db:MetadataDatabase,scheduler:BackupScheduler;
 let busy=false,protectedState:any=null;const create=vi.fn(async()=>{busy=true;});
 const jobs={busy:()=>busy,create} as unknown as BackupJobs;
 const backups={status:()=>({configured:true}),protection:async()=>protectedState} as unknown as BackupService;
 const config={enabled:true,debounceSeconds:60,maxWaitSeconds:600,intervalHours:24};
 beforeEach(async()=>{root=await mkdtemp(path.join(os.tmpdir(),'mynote-schedule-'));vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));db=new MetadataDatabase(path.join(root,'metadata.sqlite'));scheduler=new BackupScheduler(db,jobs,backups,config);busy=false;protectedState=null;create.mockClear();});
 afterEach(async()=>{await scheduler.close();db.close();vi.useRealTimers();await rm(root,{recursive:true,force:true});});
 const advance=(seconds:number)=>vi.setSystemTime(Date.now()+seconds*1000);
 it('新变更延后防抖，多个客户端的变更只触发一个任务',async()=>{
  advance(50);db.markBackupChange();advance(50);await scheduler.tick();expect(create).not.toHaveBeenCalled();
  advance(10);await Promise.all([scheduler.tick(),scheduler.tick()]);expect(create).toHaveBeenCalledTimes(1);expect(create).toHaveBeenCalledWith('backup',undefined,'scheduled','debounce');
 });
 it('持续编辑不超过最大等待时间',async()=>{
  for(let i=0;i<11;i++){advance(50);db.markBackupChange();await scheduler.tick();}
  expect(create).not.toHaveBeenCalled();advance(50);db.markBackupChange();await scheduler.tick();expect(create).toHaveBeenCalledTimes(1);
 });
 it('完成只确认捕获时的变更，上传期间的新修改另触发一批',async()=>{
  advance(60);await scheduler.tick();const captured=db.backupScheduleState().revision;
  advance(20);db.markBackupChange();db.backupSucceeded(captured);busy=false;
  expect(scheduler.status().pendingChanges).toBe(1);advance(59);await scheduler.tick();expect(create).toHaveBeenCalledTimes(1);
  advance(1);await scheduler.tick();expect(create).toHaveBeenCalledTimes(2);
 });
 it('重启保留原定时间，不重新等待完整防抖窗口',async()=>{
  advance(40);await scheduler.close();db.close();db=new MetadataDatabase(path.join(root,'metadata.sqlite'));scheduler=new BackupScheduler(db,jobs,backups,config);
  advance(20);await scheduler.tick();expect(create).toHaveBeenCalledTimes(1);
 });
 it('失败指数退避，新编辑不能绕过退避；保护错误停止自动重试',async()=>{
  advance(60);await scheduler.tick();db.backupFailed('NETWORK_ERROR');busy=false;
  advance(30);db.markBackupChange();await scheduler.tick();expect(create).toHaveBeenCalledTimes(1);
  advance(60);await scheduler.tick();expect(create).toHaveBeenCalledTimes(2);
  db.backupFailed('BACKUP_ABNORMAL_DROP');busy=false;advance(7200);await scheduler.tick();expect(create).toHaveBeenCalledTimes(2);expect(scheduler.status().blockedReason).toBe('BACKUP_ABNORMAL_DROP');
 });
 it('无修改不运行，24小时兜底检查；恢复保护期间不创建任务',async()=>{
  db.backupSucceeded(db.backupScheduleState().revision);advance(3600);await scheduler.tick();expect(create).not.toHaveBeenCalled();
  advance(23*3600);protectedState={phase:'downloading'};await scheduler.tick();expect(create).not.toHaveBeenCalled();
  protectedState=null;await scheduler.tick();expect(create).toHaveBeenCalledTimes(1);
 });
 it('关闭开关保留变更，开启后按原时间执行',async()=>{
  scheduler=new BackupScheduler(db,jobs,backups,{...config,enabled:false});advance(600);await scheduler.tick();expect(create).not.toHaveBeenCalled();expect(db.backupScheduleState().count).toBeGreaterThan(0);
  scheduler=new BackupScheduler(db,jobs,backups,config);await scheduler.tick();expect(create).toHaveBeenCalledTimes(1);
 });
});
