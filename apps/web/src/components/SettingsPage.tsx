import {LanguageSelect} from './LanguageSelect';
import {t, localizeMessage, useLocale} from '../lib/i18n';
import {useEffect,useRef,useState} from 'react';
import {ExternalLink,Github,X} from 'lucide-react';
import {DEFAULT_BRANDING,GITHUB_URL,getSettings,saveSettings,testS3Settings,readLogo,type AppSettings,type Branding,type S3Settings,type S3TestResult} from '../lib/settings';

export function BrandMark({branding,className='seal'}:{branding:Branding;className?:string}){
  useLocale();
 return <div className={className}>{branding.logoImage?<img src={branding.logoImage} alt={t("应用 Logo")}/>:<span>{branding.logoText}</span>}</div>;
}
export function SettingsPage({onClose,onSaved}:{onClose:()=>void;onSaved:(branding:Branding)=>void}){
  useLocale();
 const dialog=useRef<HTMLDialogElement>(null),upload=useRef<HTMLInputElement>(null);
 const [value,setValue]=useState<AppSettings|null>(null),[tab,setTab]=useState<'appearance'|'backup'|'about'>('appearance');
 const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[testing,setTesting]=useState(false),[test,setTest]=useState<S3TestResult|null>(null);
 const [dirty,setDirty]=useState(false),[clearCredentials,setClearCredentials]=useState(false);
 useEffect(()=>{dialog.current?.showModal();let active=true;void getSettings().then(v=>{if(active)setValue(v);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[]);
 useEffect(()=>{
  if(!dirty)return;
  const guard=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};
  window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);
 },[dirty]);
 const pending=busy||testing;
 const close=()=>{if(pending)return;if(dirty&&!window.confirm(t("设置尚未保存，放弃修改并关闭？")))return;onClose();};
 function brand(patch:Partial<Branding>){setValue(v=>v?{...v,branding:{...v.branding,...patch}}:v);setDirty(true);setNotice('');}
 function s3(patch:Partial<S3Settings>){setValue(v=>v?{...v,s3:{...v.s3,...patch}}:v);setDirty(true);setTest(null);setNotice('');}
 async function save(){if(!value)return;if(value.s3.maxWaitSeconds<value.s3.debounceSeconds){setError(t("最长等待时间不能小于静默等待时间。"));return;}setBusy(true);setError('');setNotice('');try{const saved=await saveSettings(value,clearCredentials);setValue(saved);setClearCredentials(false);setDirty(false);onSaved(saved.branding);setNotice(t("已保存，设置已生效。"));}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 async function check(){if(!value)return;setTesting(true);setError('');setTest(null);try{setTest(await testS3Settings(value.s3));}catch(e){setError((e as Error).message);}finally{setTesting(false);}}
 const number=(key:'retention'|'debounceSeconds'|'maxWaitSeconds'|'intervalHours'|'verifyIntervalHours',label:string,min:number,max:number)=><label>{label}<input type="number" min={min} max={max} required value={value!.s3[key]} onChange={e=>s3({[key]:Number(e.target.value)})}/></label>;
 return <dialog ref={dialog} className="settings-dialog" aria-labelledby="settings-title" onCancel={e=>{e.preventDefault();close();}}>
  <header><div><p className="eyebrow">{t("你的笔记工作台")}</p><h2 id="settings-title">{t("设置")}</h2></div><button className="icon-btn" aria-label={t("关闭设置")} disabled={pending} onClick={close}><X size={20}/></button></header>
  <nav aria-label={t("设置分类")}>{([['appearance',t("外观")],['backup',t("S3 备份")],['about',t("关于")]] as const).map(([key,label])=><button key={key} className={tab===key?'active':''} aria-current={tab===key?'page':undefined} onClick={()=>setTab(key)}>{label}</button>)}</nav>
  <form onSubmit={e=>{e.preventDefault();void save();}}>
  <div className="settings-body">
   {error&&<p role="alert" className="backup-error">{localizeMessage(error)}</p>}{notice&&<p role="status" className="settings-success">{localizeMessage(notice)}</p>}
   {!value&&!error&&<p role="status">{t("正在读取设置…")}</p>}
   {value&&<fieldset disabled={pending}>
    {tab==='appearance'&&<section><label>{t('界面语言')}<LanguageSelect/></label><p className="muted">{t('只影响当前浏览器，不会翻译笔记内容。')}</p><h3>{t("应用外观")}</h3><p className="muted">{t("在所有浏览器中生效；修改名称不会移动笔记或更改备份目录。")}</p>
     <div className="settings-brand-preview"><BrandMark branding={value.branding}/><strong>{value.branding.name}</strong></div>
     <label>{t("应用名称")}<input required maxLength={40} value={value.branding.name} onChange={e=>brand({name:e.target.value})}/></label>
     <h4>{t("Logo 图片")}</h4>
     <p className="muted">{t("这里设置左上角和登录页使用的图片 Logo。当前没有图片时会显示内置的临时占位标记。")}</p>
     <input ref={upload} type="file" accept="image/png,image/jpeg,image/webp" aria-label={t("选择应用 Logo 图片")} hidden onChange={e=>{const file=e.target.files?.[0];if(file)void readLogo(file).then(logoImage=>brand({logoImage})).catch(e=>setError(e.message));e.target.value='';}}/>
     <div className="settings-inline"><button type="button" onClick={()=>upload.current?.click()}>{t("选择 Logo 图片")}</button>{value.branding.logoImage&&<button type="button" onClick={()=>brand({logoImage:''})}>{t("移除图片")}</button>}<button type="button" onClick={()=>brand(DEFAULT_BRANDING)}>{t("恢复默认外观")}</button></div><p className="muted">{t("支持任意尺寸的 PNG、JPEG、WebP，浏览器会自动缩放压缩到适合 Logo 的尺寸（最长边 512px，最终不超过 512 KB）。")}</p>
    </section>}
    {tab==='backup'&&<section><h3>{t("服务端 S3 备份")}<span className="settings-optional">{t("可选")}</span></h3><p className="muted">{t("笔记正常使用不依赖 S3。浏览器先同步到服务端，再由服务端将笔记和附件备份到 S3；当前不包含历史数据库。")}</p>
     <label className="settings-check"><input type="checkbox" disabled={clearCredentials} checked={value.s3.enabled} onChange={e=>s3({enabled:e.target.checked})}/>{t("启用 S3 备份")}</label>
     <div className="settings-grid">
      <label>Endpoint<input type="url" placeholder="https://s3.example.com" value={value.s3.endpoint} onChange={e=>s3({endpoint:e.target.value})}/><small>{t("标准 AWS S3 可留空；兼容服务填写服务商地址。")}</small></label>
      <label>Region<input required value={value.s3.region} onChange={e=>s3({region:e.target.value})}/></label>
      <label>{t("存储桶 Bucket")}<input value={value.s3.bucket} onChange={e=>s3({bucket:e.target.value})}/></label>
      <label>{t("备份前缀")}<input required value={value.s3.prefix} onChange={e=>s3({prefix:e.target.value})}/></label>
      <label>Access Key<input autoComplete="off" spellCheck={false} disabled={clearCredentials} value={value.s3.accessKeyId} placeholder={value.s3.hasAccessKey&&!clearCredentials?t("已保存；留空保持原值"):t("填写 Access Key")} onChange={e=>s3({accessKeyId:e.target.value})}/></label>
      <label>Secret Key<input type="password" autoComplete="new-password" disabled={clearCredentials} value={value.s3.secretAccessKey} placeholder={value.s3.hasSecretKey&&!clearCredentials?t("已保存；留空保持原值"):t("填写 Secret Key")} onChange={e=>s3({secretAccessKey:e.target.value})}/></label>
     </div>
     <p className="muted">{t("已保存密钥不会回显；留空保持原值。密钥不会缓存在浏览器。")}</p>
     <label className="settings-check"><input type="checkbox" checked={value.s3.forcePathStyle} onChange={e=>s3({forcePathStyle:e.target.checked})}/>{t("使用 Path-style 地址（部分 MinIO / S3 兼容服务需要）")}</label>
     <label>{t("服务端加密")}<select value={value.s3.serverSideEncryption} onChange={e=>s3({serverSideEncryption:e.target.value as S3Settings['serverSideEncryption']})}><option value="none">{t("不额外指定（遵循桶设置）")}</option><option value="AES256">AES256</option><option value="aws:kms">AWS KMS</option></select></label>
     {value.s3.serverSideEncryption==='aws:kms'&&<label>KMS Key ID<input required value={value.s3.kmsKeyId} onChange={e=>s3({kmsKeyId:e.target.value})}/></label>}
     <label className="settings-check"><input type="checkbox" checked={clearCredentials} onChange={e=>{setClearCredentials(e.target.checked);s3({enabled:false,scheduleEnabled:false,accessKeyId:'',secretAccessKey:''});}}/>{t("保存时清除已保存密钥并关闭备份")}</label>
     <div className="settings-inline"><button type="button" disabled={clearCredentials} onClick={()=>void check()}>{testing?t("正在测试…"):t("测试 S3 连接")}</button><small>{t("测试未保存的配置；不会启动备份。")}</small></div>
     <p className="muted">{t("测试会列举前缀，并写入、读取、删除一个 32 字节的独立测试对象，不修改历史快照。需要相应权限。")}</p>
     {test&&<p role="status" className={test.ok?'settings-success':'backup-error'}>{test.ok?t("连接测试通过：列举、写入、读取、删除成功（{0} 秒）。", (test.durationMs/1000).toFixed(2)):t("连接测试失败：{0}阶段{1}。请检查地址、地区、密钥和桶权限。", ({list:t("列举对象"),write:t("写入对象"),read:t("读取对象")} as Record<string,string>)[test.stage]||t("请求"), ({TIMEOUT:t("连接超时"),ACCESS_DENIED:t("权限不足"),CONTENT_MISMATCH:t("内容校验不一致"),S3_REQUEST_FAILED:t("连接或 S3 请求失败")} as Record<string,string>)[test.code||'']||t("失败"))}</p>}
     <hr/><h3>{t("自动备份")}</h3><label className="settings-check"><input type="checkbox" disabled={!value.s3.enabled} checked={value.s3.scheduleEnabled} onChange={e=>s3({scheduleEnabled:e.target.checked})}/>{t("自动合并变更并备份")}</label>
     <div className="settings-grid">{number('debounceSeconds',t("静默等待（秒）"),10,86400)}{number('maxWaitSeconds',t("最长等待（秒）"),10,86400)}{number('intervalHours',t("兜底检查间隔（小时）"),1,8760)}{number('verifyIntervalHours',t("全量核对间隔（小时）"),1,8760)}{number('retention',t("普通快照保留数量"),1,1000)}</div>
     <p className="muted">{t("兜底检查无变化时跳过，不是每次扫描整个桶。受保护快照额外保留；旧的未引用对象会清理。切换桶或前缀将建立新备份基线，首次可能上传全部数据，原目标保持原样。")}</p>
    </section>}
    {tab==='about'&&<section><h3>{t("关于 {0}", value.branding.name)}</h3><p>{t("轻量、自托管的个人 Markdown 笔记工作台。")}</p><a className="settings-github" href={GITHUB_URL} target="_blank" rel="noreferrer"><Github size={20}/>{t("GitHub 项目")}<ExternalLink size={15}/></a><p className="muted">gallonyin/qingji · MIT License</p><p className="muted">{t("浏览器本地缓存不是异地备份。退出登录不会清除本地笔记，公用设备请清除站点数据。")}</p></section>}
   </fieldset>}
  </div>
  <footer><span className="muted">{dirty?t("有未保存的修改"):t("设置保存在服务端")}</span><button type="button" disabled={pending} onClick={close}>{t("关闭")}</button><button className="primary" type="submit" disabled={!value||!dirty||pending}>{busy?t("保存中…"):t("保存设置")}</button></footer>
  </form>
 </dialog>;
}
