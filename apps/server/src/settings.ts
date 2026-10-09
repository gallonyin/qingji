import {randomUUID,randomBytes} from 'node:crypto';
import {chmod,readFile,rename,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {S3Client,ListObjectsV2Command,PutObjectCommand,GetObjectCommand,DeleteObjectsCommand} from '@aws-sdk/client-s3';
import {z} from 'zod';
import type {BackupConfig} from './backup-service.js';

export const GITHUB_URL='https://github.com/gallonyin/qingji';
const image=z.string().max(180000).refine(value=>{
 if(!value)return true;
 const match=/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
 if(!match)return false;
 const bytes=Buffer.from(match[2],'base64');
 if(bytes.length>512*1024)return false;
 return match[1]==='png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
  :match[1]==='jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255
  :bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP';
},'Logo must be PNG/JPEG/WebP and at most 512 KiB');
export const brandingSchema=z.object({name:z.string().trim().min(1).max(40),logoText:z.string().trim().min(1).max(8),logoImage:image});
export const s3Schema=z.object({
 enabled:z.boolean(),scheduleEnabled:z.boolean(),endpoint:z.string().trim().max(1000).refine(value=>{
  if(!value)return true;try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!u.search&&!u.hash;}catch{return false;}
 },'Endpoint must be an HTTP(S) URL without credentials'),
 region:z.string().trim().min(1).max(100),bucket:z.string().trim().max(255).regex(/^[a-zA-Z0-9._-]*$/),
 prefix:z.string().trim().max(200).transform(value=>value.replace(/^\/+|\/+$/g,'' )).refine(value=>!!value&&!value.split('/').some(v=>v==='.'||v==='..'||!v),'Use a nonempty backup prefix'),
 accessKeyId:z.string().trim().max(500),secretAccessKey:z.string().max(1000),forcePathStyle:z.boolean(),
 serverSideEncryption:z.enum(['none','AES256','aws:kms']),kmsKeyId:z.string().trim().max(500),
 retention:z.number().int().min(1).max(1000),debounceSeconds:z.number().int().min(10).max(86400),
 maxWaitSeconds:z.number().int().min(10).max(86400),intervalHours:z.number().min(1).max(8760),verifyIntervalHours:z.number().min(1).max(8760),
}).refine(s=>s.maxWaitSeconds>=s.debounceSeconds,'Max wait must be at least debounce duration')
 .refine(s=>s.serverSideEncryption!=='aws:kms'||!!s.kmsKeyId,'KMS key ID required');
export type Branding=z.infer<typeof brandingSchema>;
export type S3Settings=z.infer<typeof s3Schema>;
export interface Settings {revision:number;branding:Branding;s3:S3Settings}
export interface SettingsTransport {send(command:any,options?:{abortSignal:AbortSignal}):Promise<any>;destroy?:()=>void}
const num=(key:string,fallback:number)=>{const n=Number(process.env[key]);return Number.isFinite(n)&&n>0?n:fallback;};
export function environmentSettings():Settings{
 return {revision:0,branding:{name:'轻记',logoText:'记',logoImage:''},s3:{
 enabled:process.env.S3_BACKUP_ENABLED==='true',scheduleEnabled:process.env.S3_BACKUP_SCHEDULE_ENABLED==='true',
 endpoint:process.env.S3_BACKUP_ENDPOINT??'',region:process.env.S3_BACKUP_REGION??'ap-guangzhou',bucket:process.env.S3_BACKUP_BUCKET??'',prefix:process.env.S3_BACKUP_PREFIX??'mynote',
 accessKeyId:process.env.S3_BACKUP_ACCESS_KEY_ID??'',secretAccessKey:process.env.S3_BACKUP_SECRET_ACCESS_KEY??'',forcePathStyle:process.env.S3_BACKUP_FORCE_PATH_STYLE==='true',
 serverSideEncryption:process.env.S3_BACKUP_SERVER_SIDE_ENCRYPTION==='none'?'none':process.env.S3_BACKUP_SERVER_SIDE_ENCRYPTION==='aws:kms'?'aws:kms':'AES256',kmsKeyId:process.env.S3_BACKUP_KMS_KEY_ID??'',
 retention:num('S3_BACKUP_RETENTION',30),debounceSeconds:num('S3_BACKUP_DEBOUNCE_SECONDS',60),maxWaitSeconds:Math.max(num('S3_BACKUP_DEBOUNCE_SECONDS',60),num('S3_BACKUP_MAX_WAIT_SECONDS',600)),intervalHours:num('S3_BACKUP_INTERVAL_HOURS',24),verifyIntervalHours:num('S3_BACKUP_VERIFY_INTERVAL_HOURS',168),
 }};
}
export class SettingsStore{
 private value:Settings=environmentSettings();
 constructor(private root:string){}
 async initialize(){try{const raw=JSON.parse(await readFile(path.join(this.root,'settings.json'),'utf8'));this.value={revision:z.number().int().nonnegative().parse(raw.revision),branding:brandingSchema.parse(raw.branding),s3:s3Schema.parse(raw.s3)};}catch(e:any){if(e.code!=='ENOENT')throw e;this.value.s3=s3Schema.parse(this.value.s3);this.value.s3.enabled=this.value.s3.enabled&&!!(this.value.s3.bucket&&this.value.s3.accessKeyId&&this.value.s3.secretAccessKey);}}
 current(){return structuredClone(this.value);}
 public(){const value=this.current();return {...value,githubUrl:GITHUB_URL,s3:{...value.s3,accessKeyId:'',secretAccessKey:'',hasAccessKey:!!value.s3.accessKeyId,hasSecretKey:!!value.s3.secretAccessKey}};}
 candidate(body:unknown):Settings{
  const input=z.object({revision:z.number().int().nonnegative(),branding:brandingSchema,s3:s3Schema,clearCredentials:z.boolean().optional()}).parse(body);
  if(input.revision!==this.value.revision)throw new Error('SETTINGS_CONFLICT');
  const s3={...input.s3,accessKeyId:input.clearCredentials?'':input.s3.accessKeyId||this.value.s3.accessKeyId,secretAccessKey:input.clearCredentials?'':input.s3.secretAccessKey||this.value.s3.secretAccessKey};
  if(s3.enabled)assertCredentials(s3);
  return {revision:input.revision+1,branding:input.branding,s3};
 }
 testCandidate(body:unknown){const value=s3Schema.parse(body);const next={...value,accessKeyId:value.accessKeyId||this.value.s3.accessKeyId,secretAccessKey:value.secretAccessKey||this.value.s3.secretAccessKey};assertCredentials(next);return next;}
 async save(next:Settings){const file=path.join(this.root,'settings.json'),temp=file+'.'+randomUUID()+'.tmp';
  await writeFile(temp,JSON.stringify(next,null,2),{mode:0o600});await chmod(temp,0o600);await rename(temp,file);this.value=structuredClone(next);
 }
}
function assertCredentials(s:S3Settings){if(!s.bucket||!s.accessKeyId||!s.secretAccessKey)throw new Error('S3_SETTINGS_INCOMPLETE');}
export function backupConfig(s:S3Settings):BackupConfig{return {enabled:s.enabled&&!!(s.bucket&&s.accessKeyId&&s.secretAccessKey),bucket:s.bucket,prefix:s.prefix,retention:s.retention,intervalHours:s.intervalHours,verifyIntervalHours:s.verifyIntervalHours,endpoint:s.endpoint,serverSideEncryption:s.serverSideEncryption==='none'?undefined:s.serverSideEncryption,kmsKeyId:s.kmsKeyId||undefined};}
export function s3Transport(s:S3Settings){return new S3Client({region:s.region,endpoint:s.endpoint||undefined,forcePathStyle:s.forcePathStyle,maxAttempts:2,credentials:{accessKeyId:s.accessKeyId,secretAccessKey:s.secretAccessKey}});}
export async function testS3(s:S3Settings,transport:SettingsTransport){
 const started=Date.now(),key=`${s.prefix}/.connection-test/${randomUUID()}`,payload=randomBytes(32),signal=AbortSignal.timeout(20000);let written=false,stage='list';
 try{
  await transport.send(new ListObjectsV2Command({Bucket:s.bucket,Prefix:s.prefix+'/',MaxKeys:1}),{abortSignal:signal});
  stage='write';written=true;
  await transport.send(new PutObjectCommand({Bucket:s.bucket,Key:key,Body:payload,...(s.serverSideEncryption==='none'?{}:{ServerSideEncryption:s.serverSideEncryption,...(s.serverSideEncryption==='aws:kms'?{SSEKMSKeyId:s.kmsKeyId}:{})})}),{abortSignal:signal});
  stage='read';const response=await transport.send(new GetObjectCommand({Bucket:s.bucket,Key:key}),{abortSignal:signal});
  const bytes=Buffer.from(await response.Body.transformToByteArray());if(!bytes.equals(payload))throw new Error('S3_TEST_CONTENT_MISMATCH');
 }catch(error:any){return {ok:false,stage,code:error.name==='TimeoutError'||error.name==='AbortError'?'TIMEOUT':error.$metadata?.httpStatusCode===403?'ACCESS_DENIED':error.message==='S3_TEST_CONTENT_MISMATCH'?'CONTENT_MISMATCH':'S3_REQUEST_FAILED',durationMs:Date.now()-started};}
 finally{if(written){try{const response=await transport.send(new DeleteObjectsCommand({Bucket:s.bucket,Delete:{Objects:[{Key:key}],Quiet:true}}),{abortSignal:AbortSignal.timeout(5000)});if(response.Errors?.length)throw new Error('S3_TEST_CLEANUP_FAILED');}catch{throw new Error('S3_TEST_CLEANUP_FAILED');}}}
 return {ok:true,stage:'complete',durationMs:Date.now()-started};
}
