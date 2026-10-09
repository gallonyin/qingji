import {randomUUID} from "node:crypto";
import {mkdir,readFile,writeFile,rename} from "node:fs/promises";
import path from "node:path";
import {BackupService} from "./backup-service.js";
import {BackupObservability,safeError,type BackupTelemetry} from "./backup-observability.js";
import {WriteQueue} from "./write-queue.js";

export interface BackupJob {
  id:string;
  kind:"backup"|"restore";
  snapshotId?:string;
  reason?:"manual"|"scheduled"|"pre-restore";
  state:"queued"|"running"|"succeeded"|"failed";
  createdAt:string;
  updatedAt:string;
  error?:string;
  attempt?:number;
  trigger?:string;
  startedAt?:string;
  finishedAt?:string;
  durationMs?:number;
  telemetry?:BackupTelemetry|null;
  cleanupWarning?:string;
  observabilityError?:string;
  capturedRevision?:number;
  metrics?:ReturnType<BackupService["status"]>["metrics"];
  progress?:ReturnType<BackupService["status"]>["progress"];
}

/** One durable task per vault; lifetime is independent of the HTTP request. */
export class BackupJobs {
  private jobs:BackupJob[]=[];
  private observability?:BackupObservability;
  private observe(event:string,job:BackupJob){
    try{this.observability?.record(event,{jobId:job.id,attempt:job.attempt??1,kind:job.kind,reason:job.reason,trigger:job.trigger,state:job.state,startedAt:Date.parse(job.startedAt??job.createdAt),finishedAt:job.finishedAt?Date.parse(job.finishedAt):undefined,durationMs:job.durationMs,errorCode:safeError(job.error),cleanupWarning:safeError(job.cleanupWarning),metrics:job.metrics,telemetry:job.telemetry??undefined});}
    catch(error){job.observabilityError="BACKUP_OBSERVABILITY_WRITE_FAILED";console.error(JSON.stringify({event:"backup.observability_error",jobId:job.id,code:job.observabilityError}));}
  }
  report(days:number,limit:number){return this.observability!.report(days,limit);}
  private prune(){let done=0;this.jobs=this.jobs.filter(j=>j.state==="queued"||j.state==="running"||++done<=200);}

  private active?:Promise<void>;
  private stopping=false;
  private saves:Promise<void>=Promise.resolve();
  constructor(private root:string,private backups:BackupService,private writes:WriteQueue, private beforeRun:()=>void=()=>{}, private hooks?:{checkpoint:()=>number;finished:(job:BackupJob)=>void}){}
  async initialize(){
    await mkdir(this.root,{recursive:true});
    try {this.jobs=JSON.parse(await readFile(path.join(this.root,"backup-jobs.json"),"utf8"));}
    catch(e:any){if(e.code!=="ENOENT")throw e;}
    this.observability=new BackupObservability(this.root);this.observability.recover();
    this.prune();
    for(const job of this.jobs) if(job.state==="running")job.state="queued";
    await this.save();
    this.kick();
  }
  list(){return structuredClone(this.jobs.slice(0,50));}
  busy(){return this.jobs.some(j=>j.state==="queued"||j.state==="running");}
  blocksWrites(){return this.jobs.some(j=>j.kind==="restore" && (j.state==="queued"||j.state==="running"));}
  async create(kind:BackupJob["kind"],snapshotId?:string,reason:BackupJob["reason"]="manual",trigger?:string){
    if(!this.backups.status().configured)throw new Error("S3_BACKUP_NOT_CONFIGURED");
    if(this.busy())throw new Error("S3_BACKUP_BUSY");
    const now=new Date().toISOString();
    const job:BackupJob={id:randomUUID(),kind,snapshotId,reason,trigger:trigger??reason,state:"queued",createdAt:now,updatedAt:now};
    this.jobs.unshift(job);this.prune();await this.save();this.kick();return structuredClone(job);
  }
  async retry(id:string){
    const job=this.jobs.find(j=>j.id===id);
    if(!job)throw new Error("NOT_FOUND");
    if(job.state!=="failed"||this.busy())throw new Error("S3_BACKUP_BUSY");
    if(!this.backups.status().configured)throw new Error("S3_BACKUP_NOT_CONFIGURED");
    job.state="queued";job.error=undefined;await this.save();this.kick();return structuredClone(job);
  }
  private save(){
    const data=JSON.stringify(this.jobs,null,2);
    this.saves=this.saves.catch(()=>undefined).then(async()=>{
      const file=path.join(this.root,"backup-jobs.json");
      await writeFile(file+".tmp",data);await rename(file+".tmp",file);
    });return this.saves;
  }
  private kick(){
    if(this.active||this.stopping||!this.backups.status().configured)return;
    const job=this.jobs.find(j=>j.state==="queued");if(!job)return;
    this.active=(async()=>{
      job.state="running";job.startedAt=new Date().toISOString();job.updatedAt=job.startedAt;job.finishedAt=undefined;job.durationMs=undefined;job.attempt=(job.attempt??0)+1;job.telemetry=undefined;job.metrics=undefined;job.error=undefined;
      await this.save();this.observe("started",job);
      const started=performance.now();let lastLogged=Date.now(),lastPhase="";
      let saveFailure:unknown;
      const timer=setInterval(()=>{
        const status=this.backups.status();job.progress=status.progress;job.telemetry=status.telemetry;job.metrics=status.metrics;job.durationMs=performance.now()-started;job.updatedAt=new Date().toISOString();
        if(job.progress.phase!==lastPhase||Date.now()-lastLogged>=15000){this.observe("progress",job);lastLogged=Date.now();lastPhase=job.progress.phase;}
        void this.save().catch(e=>{saveFailure=e;});
      },1000);
      try{
        this.beforeRun();
        const manifest=job.kind==="restore"
          ? await this.writes.run(async()=>{this.beforeRun();return this.backups.restore(job.snapshotId!);})
          : await this.backups.createSnapshot(job.reason ?? "manual", true, action => this.writes.run(async()=>{this.beforeRun();await action();job.capturedRevision=this.hooks?.checkpoint();}));
        if(saveFailure)throw saveFailure;
        job.snapshotId=manifest.id;job.metrics=this.backups.status().metrics;job.state="succeeded";
      }catch(error){job.state="failed";job.error=error instanceof Error?error.message:String(error);}
      finally{
        clearInterval(timer);this.hooks?.finished(job);
        const status=this.backups.status();job.progress=status.progress;job.metrics=status.metrics;job.telemetry=status.telemetry;
        job.cleanupWarning=status.cleanupError??undefined;job.finishedAt=new Date().toISOString();job.updatedAt=job.finishedAt;job.durationMs=performance.now()-started;
        await this.save();this.observe(job.state,job);
      }
    })().catch(error=>{job.state="failed";job.error=String(error);}).finally(()=>{this.active=undefined;this.kick();});
  }
  async close(){this.stopping=true;await this.active;await this.saves;this.observability?.close();this.observability=undefined;}
}
