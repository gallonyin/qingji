import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {it,expect} from 'vitest';
import {BackupObservability,BackupRunMetrics,safeError} from '../src/backup-observability.js';
it('持久化每次尝试，重启标记中断，汇总不重复累计进度',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'backup-observe-'));
 let store=new BackupObservability(root);
 try{
  const run=new BackupRunMetrics('backup');run.putBytes=123;run.finish();
  const base={jobId:'one',attempt:1,kind:'backup',state:'running',startedAt:Date.now(),telemetry:run.snapshot()};
  store.record('started',base);store.record('progress',base);
  store.close();store=new BackupObservability(root);store.recover();
  expect(store.report(7,50).summary).toMatchObject({attempts:1,interrupted:1,s3PutBytes:123});
  store.record('succeeded',{...base,attempt:2,state:'succeeded',durationMs:42});
  expect(store.report(7,50).summary).toMatchObject({attempts:2,succeeded:1,p95DurationMs:42,s3PutBytes:246});
  expect(store.report(7,1).attempts).toHaveLength(1);
 }finally{store.close();await rm(root,{recursive:true,force:true});}
});
it('日志错误脱敏，不输出路径或请求详细信息',()=>{
 expect(safeError('DISK_FULL')).toBe('DISK_FULL');
 expect(safeError('failed /private/note secret=abc')).toBe('BACKUP_ERROR');
});
