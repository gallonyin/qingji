import {t} from './i18n';
const apiBase = import.meta.env.VITE_API_URL?.replace(/\/$/, "") || "/api";

export type BackupSnapshot = {
  id: string;
  createdAt: string;
  reason: "manual" | "scheduled" | "pre-restore";
  fileCount: number;
  totalBytes: number;
};

export type BackupJob = {
  id:string;kind:"backup"|"restore";state:"queued"|"running"|"succeeded"|"failed";snapshotId?:string;error?:string;
  startedAt?:string;finishedAt?:string;durationMs?:number;attempt?:number;
  telemetry?:{s3PutBytes:number;s3GetBytes:number;s3Calls:number;s3Errors:number;sdkAttempts:number;writeLockMs:number;queueWaitMs:number;averageUploadBytesPerSecond:number;bottleneck:{phase:string;durationMs:number}|null};
  cleanupWarning?:string;observabilityError?:string;
  metrics?:{hashedFiles:number;hashedBytes:number;reusedHashes:number;uploadedFiles:number;uploadedBytes:number;skipped:boolean;fullCheck:boolean};
  progress?:{phase:string;totalFiles:number;completedFiles:number;totalBytes:number;completedBytes:number;startedAt:number;lastProgressAt:number};
};
export type BackupStatus = {
  jobs?: BackupJob[];
  scheduleEnabled?:boolean;
  automation?:{enabled:boolean;debounceSeconds:number;maxWaitSeconds:number;pendingChanges:number;nextRunAt:number|null;retryAt:number|null;blockedReason:string|null;lastSuccessAt:number|null};
  configured: boolean;
  running: boolean;
  lastBackup: BackupSnapshot | null;
  lastError: string | null;
  cleanupError?: string | null;
  metrics?: {hashedFiles:number;hashedBytes:number;reusedHashes:number;uploadedFiles:number;uploadedBytes:number;skipped:boolean;fullCheck:boolean};
  protection?: { phase: string; snapshotId?: string } | null;
  retention: number;
  intervalHours: number;
};

function headers(json = false): HeadersInit {
  const token = localStorage.getItem("mynote:token");
  return {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(json ? { "content-type": "application/json" } : {})
  };
}

async function result<T>(response: Response): Promise<T> {
  const raw = await response.text();
  let data: { error?: string } & Record<string, unknown> = {};
  try {
    data = raw ? JSON.parse(raw) as typeof data : {};
  } catch {
    // Proxies and upstream outages can return an HTML/empty 5xx body.
  }
  const messages: Record<string, string> = {
    BACKUP_ABNORMAL_DROP: t("数据数量或容量异常减少，已拦截备份；云端历史快照未被删除。"),
    BACKUP_PROTECTED: t("恢复保护中，已暂停写入和备份。请完成恢复后再试。"),
    RESTORE_RECOVERY_REQUIRED: t("恢复切换曾中断，已保留现场，需要管理员检查回滚目录。")
  };
  if (!response.ok) throw new Error(messages[data.error ?? ""] || data.error || t("备份服务请求失败（{0}）", response.status));
  return data as T;
}

export async function getBackupStatus(): Promise<BackupStatus> {
  return result(await fetch(`${apiBase}/backups/status`, { headers: headers() }));
}

export async function listBackups(): Promise<BackupSnapshot[]> {
  const data = await result<{ snapshots: BackupSnapshot[] }>(
    await fetch(`${apiBase}/backups`, { headers: headers() })
  );
  return data.snapshots;
}

export async function createBackup(): Promise<BackupJob> {
  const data = await result<{ job: BackupJob }>(await fetch(`${apiBase}/backups`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({ reason: "manual" })
  }));
  return data.job;
}

export async function restoreBackup(snapshotId: string): Promise<BackupJob> {
  const data = await result<{ job: BackupJob }>(
    await fetch(`${apiBase}/backups/${encodeURIComponent(snapshotId)}/restore`, {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify({ confirm: snapshotId })
    })
  );
  return data.job;
}

export async function retryBackupJob(id:string):Promise<BackupJob>{
 const data=await result<{job:BackupJob}>(await fetch(`${apiBase}/backup-jobs/${id}/retry`,{method:"POST",headers:headers(true),body:"{}"}));
 return data.job;
}
