import type { MetadataDatabase } from "./database.js";
import type { BackupJobs } from "./backup-jobs.js";
import type { BackupService } from "./backup-service.js";

export interface BackupScheduleConfig { enabled:boolean; debounceSeconds:number; maxWaitSeconds:number; intervalHours:number; }
const positive=(value:string|undefined,fallback:number)=>{const n=Number(value);return Number.isFinite(n)&&n>0?n:fallback;};
export function backupScheduleConfig(intervalHours:number):BackupScheduleConfig {
  const debounceSeconds=positive(process.env.S3_BACKUP_DEBOUNCE_SECONDS,60);
  return {enabled:process.env.S3_BACKUP_SCHEDULE_ENABLED==="true",debounceSeconds,maxWaitSeconds:Math.max(debounceSeconds,positive(process.env.S3_BACKUP_MAX_WAIT_SECONDS,600)),intervalHours};
}

/** Poll durable change timestamps; empty sync requests do not move the deadline. */
export class BackupScheduler {
  private timer?:NodeJS.Timeout;
  private active?:Promise<void>;
  private stopped=false;
  constructor(private metadata:MetadataDatabase,private jobs:BackupJobs,private backups:BackupService,readonly config:BackupScheduleConfig){}
  status() {
    const state=this.metadata.backupScheduleState();
    const enabled=this.config.enabled&&this.backups.status().configured;
    const changeDue=state.count?Math.min(state.lastAt!+this.config.debounceSeconds*1000,state.firstAt!+this.config.maxWaitSeconds*1000):Infinity;
    const periodicDue=(state.lastSuccessAt||state.firstAt||Date.now())+this.config.intervalHours*3600_000;
    const next=Math.max(Math.min(changeDue,periodicDue),state.retryAt);
    return {enabled,debounceSeconds:this.config.debounceSeconds,maxWaitSeconds:this.config.maxWaitSeconds,pendingChanges:state.count,nextRunAt:enabled&&!state.blockedReason?next:null,retryAt:state.retryAt||null,blockedReason:state.blockedReason,lastSuccessAt:state.lastSuccessAt||null};
  }
  start(onError:(error:unknown)=>void) {
    if(!this.status().enabled||this.timer)return;
    this.timer=setInterval(()=>void this.tick().catch(onError),1000);this.timer.unref();
  }
  tick():Promise<void> {
    if(this.active)return this.active;
    this.active=(async()=>{
      const status=this.status();
      if(this.stopped||!status.enabled||status.nextRunAt===null||Date.now()<status.nextRunAt||this.jobs.busy()||await this.backups.protection())return;
      try { const state=this.metadata.backupScheduleState();
        const trigger=state.retryAt?"retry":state.count?(Date.now()>=state.firstAt!+this.config.maxWaitSeconds*1000?"max-wait":"debounce"):"periodic";
        await this.jobs.create("backup",undefined,"scheduled",trigger); }
      catch(error) { if(!(error instanceof Error&&error.message==="S3_BACKUP_BUSY"))throw error; }
    })().finally(()=>{this.active=undefined;});
    return this.active;
  }
  async close(){this.stopped=true;if(this.timer)clearInterval(this.timer);await this.active;}
  resume(onError:(error:unknown)=>void){this.timer=undefined;this.stopped=false;this.start(onError);}
  configure(config:BackupScheduleConfig){Object.assign(this.config,config);}
}
