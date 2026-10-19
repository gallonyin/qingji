import {renderHook,act,cleanup,waitFor} from '@testing-library/react';
import {afterEach,it,expect,vi} from 'vitest';
import {useSaveShortcut} from './use-save-shortcut';
afterEach(()=>{cleanup();vi.useRealTimers();});
function shortcut(init:KeyboardEventInit={}) {
 const event=new KeyboardEvent('keydown',{key:'s',ctrlKey:true,bubbles:true,cancelable:true,...init});
 act(()=>{document.dispatchEvent(event);});return event;
}
it('Ctrl+S prevents browser save and acknowledges only after pending edits persist',async()=>{
 let finish!:(value:boolean)=>void;
 const save=vi.fn(()=>new Promise<boolean>(resolve=>{finish=resolve;}));
 const {result}=renderHook(()=>useSaveShortcut(true,save));
 expect(shortcut().defaultPrevented).toBe(true);expect(save).toHaveBeenCalledTimes(1);expect(result.current).toBeNull();
 await act(async()=>finish(true));expect(result.current?.message).toBe('已保存到本机');
});
it('Cmd+S acknowledges autosave; repeated shortcuts serialize and can be used again',async()=>{
 const save=vi.fn().mockResolvedValue(false);const {result}=renderHook(()=>useSaveShortcut(true,save));
 expect(shortcut({ctrlKey:false,metaKey:true}).defaultPrevented).toBe(true);
 expect(shortcut({repeat:true}).defaultPrevented).toBe(true);shortcut();
 await waitFor(()=>expect(result.current?.message).toBe('笔记已自动保存'));expect(save).toHaveBeenCalledTimes(1);
 shortcut();await waitFor(()=>expect(save).toHaveBeenCalledTimes(2));
});
it('failed saves produce an error, and retry uses the latest save callback',async()=>{
 const save=vi.fn().mockRejectedValue(new Error('disk full'));
 const {result,rerender}=renderHook(({callback})=>useSaveShortcut(true,callback),{initialProps:{callback:save}});
 shortcut();await waitFor(()=>expect(result.current?.error).toBe(true));expect(result.current?.message).toContain('disk full');
 const retry=vi.fn().mockResolvedValue(true);rerender({callback:retry});shortcut();
 await waitFor(()=>expect(result.current?.message).toBe('已保存到本机'));expect(result.current?.error).toBe(false);
});
it('does not hijack Save As, ordinary typing or disabled screens; listener is cleaned up',()=>{
 const save=vi.fn();const {unmount}=renderHook(()=>useSaveShortcut(true,save));
 expect(shortcut({shiftKey:true}).defaultPrevented).toBe(false);expect(shortcut({altKey:true}).defaultPrevented).toBe(false);expect(shortcut({ctrlKey:false}).defaultPrevented).toBe(false);
 unmount();expect(shortcut().defaultPrevented).toBe(false);
 renderHook(()=>useSaveShortcut(false,save));expect(shortcut().defaultPrevented).toBe(false);expect(save).not.toHaveBeenCalled();
});
it('captures the shortcut before an editor can swallow it, and the toast clears',async()=>{
 vi.useFakeTimers();const save=vi.fn().mockResolvedValue(false);const editor=document.createElement('textarea');document.body.append(editor);
 const editorHandler=vi.fn();editor.addEventListener('keydown',editorHandler);
 const {result}=renderHook(()=>useSaveShortcut(true,save));
 await act(async()=>{editor.dispatchEvent(new KeyboardEvent('keydown',{key:'s',ctrlKey:true,bubbles:true,cancelable:true}));});
 expect(editorHandler).not.toHaveBeenCalled();expect(result.current?.message).toBe('笔记已自动保存');
 act(()=>vi.advanceTimersByTime(2800));expect(result.current).toBeNull();editor.remove();
});
