import {render,fireEvent,screen,waitFor,cleanup} from '@testing-library/react';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {SettingsPage} from './SettingsPage';
import {getSettings,saveSettings,testS3Settings,type AppSettings} from '../lib/settings';
vi.mock('../lib/settings',async()=>({...await vi.importActual('../lib/settings'),getSettings:vi.fn(),saveSettings:vi.fn(),testS3Settings:vi.fn()}));
const defaults:AppSettings={revision:1,branding:{name:'轻记',logoText:'记',logoImage:''},githubUrl:'https://github.com/gallonyin/qingji',s3:{enabled:false,scheduleEnabled:false,endpoint:'',region:'us-east-1',bucket:'test-bucket',prefix:'mynote',accessKeyId:'',secretAccessKey:'',hasAccessKey:true,hasSecretKey:true,forcePathStyle:false,serverSideEncryption:'none',kmsKeyId:'',retention:30,debounceSeconds:60,maxWaitSeconds:600,intervalHours:24,verifyIntervalHours:168}};
beforeEach(()=>{
 HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
 vi.mocked(getSettings).mockResolvedValue(structuredClone(defaults));
 vi.mocked(saveSettings).mockImplementation(async value=>({...value,revision:value.revision+1,s3:{...value.s3,accessKeyId:'',secretAccessKey:''}}));
 vi.mocked(testS3Settings).mockResolvedValue({ok:true,stage:'complete',durationMs:100});
});
afterEach(()=>{cleanup();vi.clearAllMocks();});
it('外观保存立即通知应用，并保留安全的 GitHub 入口',async()=>{
 const onSaved=vi.fn();render(<SettingsPage onClose={vi.fn()} onSaved={onSaved}/>);
 fireEvent.change(await screen.findByLabelText('应用名称'),{target:{value:'我的书桌'}});
 fireEvent.click(screen.getByRole('button',{name:'保存设置'}));await screen.findByText('已保存，设置已生效。');expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({name:'我的书桌',logoText:'记'}));
 fireEvent.click(screen.getByRole('button',{name:'关于'}));expect(screen.getByRole('link',{name:'GitHub 项目'})).toHaveAttribute('href','https://github.com/gallonyin/qingji');
});
it('测试未保存配置不会自动保存；已保存密钥以空字段展示',async()=>{
 render(<SettingsPage onClose={vi.fn()} onSaved={vi.fn()}/>);await screen.findByLabelText('应用名称');fireEvent.click(screen.getByRole('button',{name:'S3 备份'}));
 expect(screen.getByLabelText('Secret Key')).toHaveValue('');expect(screen.getByLabelText('Secret Key')).toHaveAttribute('placeholder','已保存；留空保持原值');
 fireEvent.change(screen.getByLabelText('存储桶 Bucket'),{target:{value:'unsaved-bucket'}});fireEvent.click(screen.getByRole('button',{name:'测试 S3 连接'}));
 await screen.findByText(/连接测试通过/);expect(testS3Settings).toHaveBeenCalledWith(expect.objectContaining({bucket:'unsaved-bucket'}));expect(saveSettings).not.toHaveBeenCalled();
 fireEvent.change(screen.getByLabelText('存储桶 Bucket'),{target:{value:'different-bucket'}});expect(screen.queryByText(/连接测试通过/)).toBeNull();
});
it('失败不会关闭页面或丢弃表单；有修改时关闭需确认',async()=>{
 vi.mocked(saveSettings).mockRejectedValue(new Error('保存失败'));const onClose=vi.fn();const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
 render(<SettingsPage onClose={onClose} onSaved={vi.fn()}/>);fireEvent.change(await screen.findByLabelText('应用名称'),{target:{value:'保留编辑'}});fireEvent.click(screen.getByRole('button',{name:'保存设置'}));
 await screen.findByRole('alert');expect(screen.getByLabelText('应用名称')).toHaveValue('保留编辑');await waitFor(()=>expect(screen.getByRole('button',{name:'关闭'})).toBeEnabled());fireEvent.click(screen.getByRole('button',{name:'关闭'}));expect(confirm).toHaveBeenCalled();expect(onClose).not.toHaveBeenCalled();const unload=new Event('beforeunload',{cancelable:true});window.dispatchEvent(unload);expect(unload.defaultPrevented).toBe(true);confirm.mockRestore();
});
it('清除密钥会关闭自动备份且显式提交清除意图',async()=>{
 render(<SettingsPage onClose={vi.fn()} onSaved={vi.fn()}/>);await screen.findByLabelText('应用名称');fireEvent.click(screen.getByRole('button',{name:'S3 备份'}));
 fireEvent.click(screen.getByLabelText('保存时清除已保存密钥并关闭备份'));fireEvent.click(screen.getByRole('button',{name:'保存设置'}));await screen.findByText('已保存，设置已生效。');expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({s3:expect.objectContaining({enabled:false,scheduleEnabled:false})}),true);
});
