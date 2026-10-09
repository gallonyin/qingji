import {beforeEach,it,expect,vi} from 'vitest';
import {db,type Note} from './db';
import {restoreHistory} from './history';
const note:Note={id:'test-note',title:'本地',content:'本地内容',parentId:null,tags:[],favorite:false,createdAt:1,updatedAt:1,deletedAt:null,version:2,serverVersion:2};
const server={id:note.id,title:'历史',content:'恢复内容',folder:'',tags:[],favorite:false,createdAt:new Date(1).toISOString(),updatedAt:new Date(2).toISOString(),deletedAt:null,revision:3};
beforeEach(async()=>{vi.restoreAllMocks();await Promise.all([db.notes.clear(),db.outbox.clear(),db.conflicts.clear(),db.meta.clear()]);await db.notes.put(note);await db.meta.put({key:'vaultEpoch',value:'epoch'});localStorage.setItem('mynote:token','token');});
it('未同步内容存在时禁止恢复，不发送覆盖请求',async()=>{
 await db.outbox.add({operationId:'pending',entityId:note.id,operation:'upsert',payload:note,createdAt:1,attempts:0});
 const fetch=vi.spyOn(globalThis,'fetch');await expect(restoreHistory(note.id,1,2)).rejects.toThrow('未同步修改');expect(fetch).not.toHaveBeenCalled();
});
it('恢复携带版本和世代，跨标签页的新编辑不会被响应覆盖',async()=>{
 const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{
   const edited={...note,content:'另一标签页的新输入',version:3};await db.notes.put(edited);
   await db.outbox.add({operationId:'new',entityId:note.id,operation:'upsert',payload:edited,baseRevision:2,createdAt:1,attempts:0});
   return new Response(JSON.stringify({note:server}),{status:200});
 });
 await restoreHistory(note.id,7,2);
 expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/history/7/restore'),expect.objectContaining({headers:expect.objectContaining({'x-vault-epoch':'epoch'}),body:JSON.stringify({revision:2})}));
 expect((await db.notes.get(note.id))?.content).toBe('另一标签页的新输入');expect(await db.outbox.count()).toBe(1);
});
it('服务器拒绝并发覆盖时显示可操作错误，并保留本地内容',async()=>{
 vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({error:'REVISION_CONFLICT'}),{status:409}));
 await expect(restoreHistory(note.id,1,2)).rejects.toThrow('已有新修改');expect((await db.notes.get(note.id))?.content).toBe(note.content);
});
