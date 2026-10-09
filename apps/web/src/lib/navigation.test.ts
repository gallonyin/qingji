import {beforeEach,it,expect,vi} from 'vitest';
import {readNavigation,saveNavigation,emptyNavigation} from './navigation';
beforeEach(()=>localStorage.clear());
it('记住目录、笔记、展开状态，按账号隔离，未分类空路径保留',()=>{
 const state={view:'all' as const,folder:'My Notes/Extra',noteId:'note-2',expanded:{'My Notes':true,'My Notes/Extra':false}};
 saveNavigation('admin',state);expect(readNavigation('admin')).toEqual(state);expect(readNavigation('other')).toEqual(emptyNavigation());
 saveNavigation('admin',{...state,folder:''});expect(readNavigation('admin').folder).toBe('');
});
it('损坏或过期格式安全回退，缓存写入失败不影响浏览',()=>{
 localStorage.setItem('mynote:navigation:admin','broken');expect(readNavigation('admin')).toEqual(emptyNavigation());
 localStorage.setItem('mynote:navigation:admin',JSON.stringify({view:'invalid',folder:4,noteId:{},expanded:{a:true,b:'false'}}));
 expect(readNavigation('admin')).toEqual({...emptyNavigation(),expanded:{a:true}});
 const spy=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('full');});
 expect(()=>saveNavigation('admin',emptyNavigation())).not.toThrow();spy.mockRestore();
});
