import Database from "better-sqlite3";
import path from "node:path";
import {mkdirSync} from "node:fs";

export class BackupRunMetrics {
  private start=performance.now();
  private cpu=process.cpuUsage();
  private phaseStart=this.start;
  private phaseName="starting";
  private finishedAt:number|null=null;
  readonly startedAt=Date.now();
  readonly phases:Record<string,number>={};
  readonly operations:Record<string,{calls:number;errors:number;attempts:number;retryDelayMs:number;durationMs:number}>={};
  private activePuts=0;private putStart=0;private putActiveMs=0;
  beginPut(){if(this.activePuts++===0)this.putStart=performance.now();return ()=>{if(--this.activePuts===0)this.putActiveMs+=performance.now()-this.putStart;};}
  putBytes=0;getBytes=0;writeLockMs=0;queueWaitMs=0;peakRssBytes=process.memoryUsage().rss;
  failedPhase?:string;
  constructor(readonly kind:"backup"|"restore"){}
  phase(name:string){const now=performance.now();this.phases[this.phaseName]=(this.phases[this.phaseName]??0)+now-this.phaseStart;this.phaseName=name;this.phaseStart=now;}
  finish(){this.phase("finished");this.finishedAt=Date.now();}
  snapshot(){
    this.peakRssBytes=Math.max(this.peakRssBytes,process.memoryUsage().rss);
    const phases={...this.phases};if(!this.finishedAt)phases[this.phaseName]=(phases[this.phaseName]??0)+performance.now()-this.phaseStart;
    const durationMs=Object.values(phases).reduce((n,v)=>n+v,0);
    const ops=structuredClone(this.operations), cpu=process.cpuUsage(this.cpu);
    const bottleneck=Object.entries(phases).filter(([k])=>!["starting","completed","failed","finished"].includes(k)).sort((a,b)=>b[1]-a[1])[0];
    const putActiveMs=this.putActiveMs+(this.activePuts?performance.now()-this.putStart:0);
    return {putActiveMs,activeUploadBytesPerSecond:putActiveMs?this.putBytes/(putActiveMs/1000):0,kind:this.kind,startedAt:this.startedAt,finishedAt:this.finishedAt,durationMs,phaseMs:phases,bottleneck:bottleneck?{phase:bottleneck[0],durationMs:bottleneck[1]}:null,failedPhase:this.failedPhase,writeLockMs:this.writeLockMs,queueWaitMs:this.queueWaitMs,s3PutBytes:this.putBytes,s3GetBytes:this.getBytes,averageUploadBytesPerSecond:durationMs?this.putBytes/(durationMs/1000):0,operations:ops,s3Calls:Object.values(ops).reduce((n,o)=>n+o.calls,0),s3Errors:Object.values(ops).reduce((n,o)=>n+o.errors,0),sdkAttempts:Object.values(ops).reduce((n,o)=>n+o.attempts,0),cpuUserMs:cpu.user/1000,cpuSystemMs:cpu.system/1000,peakRssBytes:this.peakRssBytes};
  }
}

export type BackupTelemetry=ReturnType<BackupRunMetrics["snapshot"]>;
export type BackupAttempt={jobId:string;attempt:number;kind:string;reason?:string;trigger?:string;state:string;startedAt:number;finishedAt?:number;durationMs?:number;errorCode?:string;cleanupWarning?:string;metrics?:unknown;telemetry?:BackupTelemetry};
export const safeError=(error:string|undefined)=>error&&/^[A-Za-z][A-Za-z0-9_:.-]{0,100}$/.test(error)?error:error?"BACKUP_ERROR":undefined;

/** Durable attempt summaries; structured progress logs go to bounded container logs. */
export class BackupObservability {
  private db:Database.Database;
  constructor(root:string){
    mkdirSync(root,{recursive:true});this.db=new Database(path.join(root,"backup-observability.sqlite"));this.db.pragma("journal_mode=WAL");this.db.pragma("synchronous=FULL");
    this.db.exec("CREATE TABLE IF NOT EXISTS attempts(job_id TEXT, attempt INTEGER, started_at INTEGER, state TEXT, data TEXT, PRIMARY KEY(job_id,attempt)); CREATE INDEX IF NOT EXISTS attempts_started ON attempts(started_at)");
  }
  recover(){
    const rows=this.db.prepare("SELECT data FROM attempts WHERE state='running'").all() as {data:string}[];
    for(const row of rows){const a=JSON.parse(row.data) as BackupAttempt;a.state="interrupted";a.finishedAt=Date.now();a.errorCode="PROCESS_INTERRUPTED";this.record("interrupted",a);}
  }
  record(event:string,data:BackupAttempt){
    this.db.prepare("INSERT OR REPLACE INTO attempts VALUES (?,?,?,?,?)").run(data.jobId,data.attempt,data.startedAt,data.state,JSON.stringify(data));
    if(event==="started"){
      this.db.prepare("DELETE FROM attempts WHERE state<>'running' AND started_at<?").run(Date.now()-90*86400_000);
      this.db.exec("DELETE FROM attempts WHERE state<>'running' AND rowid NOT IN (SELECT rowid FROM attempts ORDER BY started_at DESC LIMIT 10000)");
    }
    if(process.env.NODE_ENV!=="test")console.log(JSON.stringify({event:`backup.${event}`,at:new Date().toISOString(),...data}));
  }
  report(days:number,limit:number){
    const rows=this.db.prepare("SELECT data FROM attempts WHERE started_at>=? ORDER BY started_at DESC").all(Date.now()-days*86400_000) as {data:string}[];
    const attempts=rows.map(r=>JSON.parse(r.data) as BackupAttempt);
    const finished=attempts.filter(a=>a.state==="succeeded"||a.state==="failed");
    const durations=finished.map(a=>a.durationMs??0).sort((a,b)=>a-b);
    const daily:Record<string,{attempts:number;succeeded:number;failed:number;uploadBytes:number;downloadBytes:number;durationMs:number}>={};
    for(const a of attempts){const key=new Date(a.startedAt).toISOString().slice(0,10);const day=daily[key]??={attempts:0,succeeded:0,failed:0,uploadBytes:0,downloadBytes:0,durationMs:0};day.attempts++;if(a.state==="succeeded")day.succeeded++;if(a.state==="failed")day.failed++;day.uploadBytes+=a.telemetry?.s3PutBytes??0;day.downloadBytes+=a.telemetry?.s3GetBytes??0;day.durationMs+=a.durationMs??0;}
    return {days,retentionDays:90,maxAttempts:10000,summary:{attempts:attempts.length,succeeded:attempts.filter(a=>a.state==="succeeded").length,failed:attempts.filter(a=>a.state==="failed").length,interrupted:attempts.filter(a=>a.state==="interrupted").length,averageDurationMs:durations.length?durations.reduce((n,v)=>n+v,0)/durations.length:0,p95DurationMs:durations.length?durations[Math.ceil(durations.length*.95)-1]:0,averageIntervalMs:attempts.length>1?(attempts[0].startedAt-attempts.at(-1)!.startedAt)/(attempts.length-1):null,s3PutBytes:attempts.reduce((n,a)=>n+(a.telemetry?.s3PutBytes??0),0),s3GetBytes:attempts.reduce((n,a)=>n+(a.telemetry?.s3GetBytes??0),0),s3Calls:attempts.reduce((n,a)=>n+(a.telemetry?.s3Calls??0),0)},daily,attempts:attempts.slice(0,limit)};
  }
  close(){this.db.close();}
}
