import {render,fireEvent,cleanup,screen,act} from '@testing-library/react';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {HoverTooltip} from './HoverTooltip';
let resizeCallback:ResizeObserverCallback;
beforeEach(()=>{vi.stubGlobal('ResizeObserver',class {constructor(callback:ResizeObserverCallback){resizeCallback=callback;} observe(){} disconnect(){}});});
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();});
it('悬停显示完整文字，移到子元素仍可显示，滚动后隐藏',()=>{
 vi.useFakeTimers();const full='微信收藏(迁移)/很长的目录名称/完整路径';
 const ui=render(<><button data-tooltip-mode="always" data-tooltip={full}><span>截断…</span></button><HoverTooltip/></>);
 fireEvent.mouseOver(ui.getByText('截断…'));act(()=>vi.advanceTimersByTime(999));
 expect(screen.queryByRole('tooltip')).toBeNull();act(()=>vi.advanceTimersByTime(1));
 expect(screen.getByRole('tooltip').textContent).toBe(full);
 fireEvent.mouseOut(ui.getByRole('button'),{relatedTarget:ui.getByText('截断…')});
 expect(screen.getByRole('tooltip')).toBeTruthy();
 fireEvent.scroll(document);expect(screen.queryByRole('tooltip')).toBeNull();
});
it('键盘焦点可查看，Escape 关闭，快速移出不出现过期提示，内容作为纯文本展示',()=>{
 vi.useFakeTimers();const ui=render(<><button data-tooltip-mode="always" data-tooltip={'<script>完整标题</script>'}>笔记</button><HoverTooltip/></>);
 const button=ui.getByRole('button');fireEvent.mouseOver(button);fireEvent.mouseOut(button);
 act(()=>vi.advanceTimersByTime(1100));expect(screen.queryByRole('tooltip')).toBeNull();
 fireEvent.focusIn(button);act(()=>vi.advanceTimersByTime(0));
 expect(screen.getByRole('tooltip').textContent).toBe('<script>完整标题</script>');
 expect(screen.getByRole('tooltip').querySelector('script')).toBeNull();
 fireEvent.keyDown(document,{key:'Escape'});expect(screen.queryByRole('tooltip')).toBeNull();
});

function dimensions(element:HTMLElement,width:number,contentWidth:number,height=20,contentHeight=20){
 Object.defineProperties(element,{clientWidth:{configurable:true,value:width},scrollWidth:{configurable:true,value:contentWidth},clientHeight:{configurable:true,value:height},scrollHeight:{configurable:true,value:contentHeight}});
}
it('完整文本不提示，宽度缩小后截断才提示，再变宽后不提示',()=>{
 vi.useFakeTimers();const ui=render(<><span data-tooltip="完整标题">完整标题</span><HoverTooltip/></>);
 const label=ui.getByText('完整标题');dimensions(label,100,100);
 fireEvent.mouseOver(label);act(()=>vi.advanceTimersByTime(1100));expect(screen.queryByRole('tooltip')).toBeNull();
 dimensions(label,50,100);fireEvent.mouseOver(label);act(()=>vi.advanceTimersByTime(1000));expect(screen.getByRole('tooltip').textContent).toBe('完整标题');
 fireEvent.mouseOut(label);dimensions(label,100,100);fireEvent.focusIn(label);expect(screen.queryByRole('tooltip')).toBeNull();
});
it('多行完整内容和一像素误差不提示，垂直截断可提示',()=>{
 const ui=render(<><span data-tooltip="多行标题">多行标题</span><HoverTooltip/></>);const label=ui.getByText('多行标题');
 dimensions(label,100,101,60,60);fireEvent.focusIn(label);expect(screen.queryByRole('tooltip')).toBeNull();
 dimensions(label,100,100,20,60);fireEvent.focusIn(label);expect(screen.getByRole('tooltip').textContent).toBe('多行标题');
});
it('键盘聚焦笔记行时检查内部标题和摘要是否截断',()=>{
 const ui=render(<><button data-tooltip="标题和摘要" data-tooltip-overflow=".label"><span className="label">标题</span><span className="label">摘要</span></button><HoverTooltip/></>);
 const button=ui.getByRole('button');dimensions(button,200,200);dimensions(ui.getByText('标题'),100,100);dimensions(ui.getByText('摘要'),100,100);
 fireEvent.focusIn(button);expect(screen.queryByRole('tooltip')).toBeNull();
 dimensions(ui.getByText('摘要'),50,100);fireEvent.focusIn(button);expect(screen.getByRole('tooltip').textContent).toBe('标题和摘要');
});

it('气泡打开期间文字恢复完整时自动关闭',()=>{
 const ui=render(<><span data-tooltip="长标题">长标题</span><HoverTooltip/></>);const label=ui.getByText('长标题');
 dimensions(label,50,100);fireEvent.focusIn(label);expect(screen.getByRole('tooltip')).toBeTruthy();
 dimensions(label,100,100);act(()=>resizeCallback([],{} as ResizeObserver));expect(screen.queryByRole('tooltip')).toBeNull();
});

it('鼠标经过间隙进入气泡后保持显示，离开气泡后延迟关闭',()=>{
 vi.useFakeTimers();const ui=render(<><button data-tooltip-mode="always" data-tooltip="可复制的完整文本">标题</button><HoverTooltip/></>);
 const anchor=ui.getByRole('button');fireEvent.mouseOver(anchor);act(()=>vi.advanceTimersByTime(1000));
 const bubble=screen.getByRole('tooltip');fireEvent.mouseOut(anchor,{relatedTarget:document.body});fireEvent.mouseOver(document.body);
 act(()=>vi.advanceTimersByTime(200));expect(screen.getByRole('tooltip')).toBe(bubble);
 fireEvent.mouseOver(bubble,{relatedTarget:document.body});act(()=>vi.advanceTimersByTime(500));expect(screen.getByRole('tooltip')).toBe(bubble);
 fireEvent.mouseOut(bubble,{relatedTarget:document.body});act(()=>vi.advanceTimersByTime(349));expect(screen.getByRole('tooltip')).toBe(bubble);
 act(()=>vi.advanceTimersByTime(1));expect(screen.queryByRole('tooltip')).toBeNull();
});
it('气泡可聚焦复制，选字拖出边界期间不关闭，松开后关闭',()=>{
 vi.useFakeTimers();const ui=render(<><button data-tooltip-mode="always" data-tooltip="完整文本">标题</button><HoverTooltip/></>);
 fireEvent.focusIn(ui.getByRole('button'));const bubble=screen.getByRole('tooltip');expect(bubble.tabIndex).toBe(0);
 fireEvent.focusOut(ui.getByRole('button'),{relatedTarget:bubble});fireEvent.focusIn(bubble);act(()=>vi.advanceTimersByTime(500));expect(screen.getByRole('tooltip')).toBe(bubble);
 fireEvent.mouseDown(bubble);fireEvent.mouseOut(bubble,{relatedTarget:document.body});fireEvent.mouseOver(document.body);
 act(()=>vi.advanceTimersByTime(1000));expect(screen.getByRole('tooltip')).toBe(bubble);
 fireEvent.mouseUp(document.body);act(()=>vi.advanceTimersByTime(350));expect(screen.queryByRole('tooltip')).toBeNull();
});
it('直接移入气泡再移回标题不闪烁，Escape 立即关闭',()=>{
 vi.useFakeTimers();const ui=render(<><button data-tooltip-mode="always" data-tooltip="完整文本">标题</button><HoverTooltip/></>);const anchor=ui.getByRole('button');
 fireEvent.focusIn(anchor);const bubble=screen.getByRole('tooltip');fireEvent.mouseOut(anchor,{relatedTarget:bubble});fireEvent.mouseOver(bubble);
 fireEvent.mouseOut(bubble,{relatedTarget:anchor});fireEvent.mouseOver(anchor);act(()=>vi.advanceTimersByTime(500));expect(screen.getByRole('tooltip')).toBe(bubble);
 fireEvent.keyDown(bubble,{key:'Escape'});expect(screen.queryByRole('tooltip')).toBeNull();
});

it('从笔记行经过内部标题和摘要移向气泡时不会立即销毁气泡',()=>{
 vi.useFakeTimers();const ui=render(<><button data-tooltip-mode="always" data-tooltip="标题和摘要"><span data-tooltip-mode="always" data-tooltip="标题">标题</span><span data-tooltip-mode="always" data-tooltip="摘要">摘要</span></button><HoverTooltip/></>);
 const anchor=ui.getByRole('button');fireEvent.focusIn(anchor);const bubble=screen.getByRole('tooltip');
 fireEvent.mouseOver(ui.getByText('标题'));expect(screen.getByRole('tooltip')).toBe(bubble);
 fireEvent.mouseOut(ui.getByText('标题'),{relatedTarget:ui.getByText('摘要')});fireEvent.mouseOver(ui.getByText('摘要'));expect(screen.getByRole('tooltip')).toBe(bubble);
 fireEvent.mouseOut(anchor,{relatedTarget:bubble});fireEvent.mouseOver(bubble);act(()=>vi.advanceTimersByTime(1000));expect(screen.getByRole('tooltip')).toBe(bubble);
});
it('经过另一个提示文字时，等待新提示期间旧气泡不闪退，进入旧气泡取消切换',()=>{
 vi.useFakeTimers();const ui=render(<><button data-tooltip-mode="always" data-tooltip="原来的完整文本">原文</button><button data-tooltip-mode="always" data-tooltip="另一段完整文本">下一行</button><HoverTooltip/></>);
 fireEvent.focusIn(ui.getByText('原文'));const bubble=screen.getByRole('tooltip');
 fireEvent.mouseOver(ui.getByText('下一行'));act(()=>vi.advanceTimersByTime(150));expect(screen.getByRole('tooltip')).toBe(bubble);
 fireEvent.mouseOver(bubble);act(()=>vi.advanceTimersByTime(500));expect(screen.getByRole('tooltip')).toBe(bubble);
});
