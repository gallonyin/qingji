import {afterEach, expect, it, vi} from 'vitest';
import {startVisiblePolling} from './visible-polling';
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
it('空闲降频、运行加速、隐藏停止、回到前台立即刷新', async()=>{
 vi.useFakeTimers();let hidden=false;
 vi.spyOn(document,'hidden','get').mockImplementation(()=>hidden);
 vi.spyOn(navigator,'onLine','get').mockReturnValue(true);
 const poll=vi.fn().mockResolvedValueOnce(60000).mockResolvedValue(3000);
 const stop=startVisiblePolling(poll);
 await vi.advanceTimersByTimeAsync(59999);expect(poll).toHaveBeenCalledTimes(1);
 await vi.advanceTimersByTimeAsync(1);expect(poll).toHaveBeenCalledTimes(2);
 await vi.advanceTimersByTimeAsync(3000);expect(poll).toHaveBeenCalledTimes(3);
 hidden=true;document.dispatchEvent(new Event('visibilitychange'));
 await vi.advanceTimersByTimeAsync(120000);expect(poll).toHaveBeenCalledTimes(3);
 hidden=false;document.dispatchEvent(new Event('visibilitychange'));
 await vi.advanceTimersByTimeAsync(0);expect(poll).toHaveBeenCalledTimes(4);
 stop();await vi.advanceTimersByTimeAsync(60000);expect(poll).toHaveBeenCalledTimes(4);
});
it('慢请求不重叠、离线停止、销毁后在途请求不重启定时器',async()=>{
 vi.useFakeTimers();vi.spyOn(document,'hidden','get').mockReturnValue(false);
 let online=true;vi.spyOn(navigator,'onLine','get').mockImplementation(()=>online);
 let finish!:(n:number)=>void;const poll=vi.fn(()=>new Promise<number>(resolve=>{finish=resolve;}));
 const stop=startVisiblePolling(poll);
 window.dispatchEvent(new Event('online'));await vi.advanceTimersByTimeAsync(120000);expect(poll).toHaveBeenCalledTimes(1);
 online=false;window.dispatchEvent(new Event('offline'));finish(3000);
 await vi.advanceTimersByTimeAsync(60000);expect(poll).toHaveBeenCalledTimes(1);
 online=true;window.dispatchEvent(new Event('online'));expect(poll).toHaveBeenCalledTimes(2);
 stop();finish(3000);await vi.advanceTimersByTimeAsync(60000);expect(poll).toHaveBeenCalledTimes(2);
});
