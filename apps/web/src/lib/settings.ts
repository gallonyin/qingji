const apiBase=import.meta.env.VITE_API_URL?.replace(/\/$/,'')||'/api';
export const GITHUB_URL='https://github.com/gallonyin/qingji';
export interface Branding{name:string;logoText:string;logoImage:string;githubUrl?:string}
export interface S3Settings{
 enabled:boolean;scheduleEnabled:boolean;endpoint:string;region:string;bucket:string;prefix:string;
 accessKeyId:string;secretAccessKey:string;hasAccessKey?:boolean;hasSecretKey?:boolean;forcePathStyle:boolean;
 serverSideEncryption:'none'|'AES256'|'aws:kms';kmsKeyId:string;retention:number;debounceSeconds:number;maxWaitSeconds:number;intervalHours:number;verifyIntervalHours:number;
}
export interface AppSettings{revision:number;branding:Branding;s3:S3Settings;githubUrl:string}
export interface S3TestResult{ok:boolean;stage:string;code?:string;durationMs:number}
const cacheKey='mynote:branding';
export const DEFAULT_BRANDING:Branding={name:'轻记',logoText:'记',logoImage:'',githubUrl:GITHUB_URL};
export function cachedBranding():Branding{try{const b=JSON.parse(localStorage.getItem(cacheKey)||'null');return b&&typeof b.name==='string'&&typeof b.logoText==='string'&&typeof b.logoImage==='string'?{name:b.name,logoText:b.logoText,logoImage:b.logoImage,githubUrl:GITHUB_URL}:DEFAULT_BRANDING;}catch{return DEFAULT_BRANDING;}}
export function cacheBranding(b:Branding){try{localStorage.setItem(cacheKey,JSON.stringify({...b,githubUrl:GITHUB_URL}));}catch{/* Branding caching must not prevent using the app. */}}
async function request<T>(url:string,method='GET',payload?:unknown):Promise<T>{
 const token=localStorage.getItem('mynote:token');const response=await fetch(apiBase+url,{method,headers:{...(token?{authorization:`Bearer ${token}`} :{}),...(payload?{'content-type':'application/json'}:{})},...(payload?{body:JSON.stringify(payload)}:{})});
 let data:any;try{data=await response.json();}catch{throw new Error('设置服务暂不可用，请稍后重试。');}
 const errors:Record<string,string>={UNAUTHORIZED:'登录已过期，请重新登录。',SETTINGS_CONFLICT:'设置已在其他窗口更新，请重新打开设置后再保存。',S3_SETTINGS_INCOMPLETE:'请填写存储桶、Access Key 和 Secret Key。',S3_BACKUP_BUSY:'备份或恢复任务正在进行，请结束后再修改 S3 配置。',BACKUP_PROTECTED:'恢复保护中，暂时不能修改 S3 配置。',S3_TEST_CLEANUP_FAILED:'测试对象清理失败，请检查删除权限；请检查备份前缀下的 .connection-test 目录。',VALIDATION_ERROR:'请检查设置：名称、Logo 格式、Endpoint、KMS 和等待时间须有效。',RATE_LIMITED:'测试过于频繁，请一分钟后重试。'};
 if(!response.ok)throw new Error(errors[data.error]||`设置请求失败（${response.status}）`);return data;
}
export const getBranding=()=>request<Branding>('/branding');
export const getSettings=()=>request<AppSettings>('/settings');
export const saveSettings=(value:AppSettings,clearCredentials=false)=>request<AppSettings>('/settings','PUT',{...value,clearCredentials});
export const testS3Settings=(value:S3Settings)=>request<S3TestResult>('/settings/s3/test','POST',value);
const MAX_LOGO_BYTES=512*1024,MAX_LOGO_EDGE=512;
export async function readLogo(file:File):Promise<string>{
 if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error('请选择 PNG、JPEG 或 WebP 图片。');
 const readOriginal=()=>new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('图片读取失败。'));reader.readAsDataURL(file);});
 if(typeof Image==='undefined'||typeof document==='undefined'||typeof URL.createObjectURL!=='function'){
  if(file.size>MAX_LOGO_BYTES)throw new Error('图片无法在当前浏览器压缩，请换用支持图片压缩的浏览器。');
  return readOriginal();
 }
 const source=URL.createObjectURL(file);
 try{
  const image=await new Promise<HTMLImageElement>((resolve,reject)=>{const element=new Image();element.onload=()=>resolve(element);element.onerror=()=>reject(new Error('图片读取失败。'));element.src=source;});
  const scale=Math.min(1,MAX_LOGO_EDGE/Math.max(image.naturalWidth||image.width,image.naturalHeight||image.height));
  const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round((image.naturalWidth||image.width)*scale));canvas.height=Math.max(1,Math.round((image.naturalHeight||image.height)*scale));
  const context=canvas.getContext('2d');if(!context)throw new Error('当前浏览器不支持图片压缩。');context.drawImage(image,0,0,canvas.width,canvas.height);
  const output=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/webp',.86));
  if(output&&output.size<=MAX_LOGO_BYTES)return new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('图片压缩失败。'));reader.readAsDataURL(output);});
  const fallback=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/jpeg',.78));
  if(fallback&&fallback.size<=MAX_LOGO_BYTES)return new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('图片压缩失败。'));reader.readAsDataURL(fallback);});
  throw new Error('图片压缩后仍超过 512 KB，请选择尺寸更小的图片。');
 }finally{URL.revokeObjectURL(source);}
}
