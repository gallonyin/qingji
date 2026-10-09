import {render,fireEvent,cleanup} from '@testing-library/react';
import {afterEach,it,expect,vi} from 'vitest';
import {MarkdownPreview} from './MarkdownPreview';
afterEach(cleanup);
it('预览保留内部导航并延迟加载图片',()=>{
 const onNavigate=vi.fn();const view=render(<MarkdownPreview content={'[[目标笔记]]\n\n![附件](/api/attachments/a/b.png)'} onNavigate={onNavigate}/>);
 fireEvent.click(view.getByText('目标笔记'));expect(onNavigate).toHaveBeenCalledWith('目标笔记');
 expect(view.getByRole('img')).toHaveAttribute('loading','lazy');
 expect(view.getByRole('img')).toHaveAttribute('decoding','async');
});
it('不放行 JavaScript、data HTML 或原始 HTML，保留正常网址和附件',()=>{
 const view=render(<MarkdownPreview content={'[危险](javascript:alert%281%29)\n\n[数据](data:text/html,test)\n\n[正常](https://example.com)\n\n<script>alert(1)</script>'} onNavigate={vi.fn()}/>);
 expect(view.getByText('危险').getAttribute('href')).not.toMatch(/^javascript:/i);expect(view.getByText('数据').getAttribute('href')).not.toMatch(/^data:/i);expect(view.getByText('正常')).toHaveAttribute('href','https://example.com');expect(view.container.querySelector('script')).toBeNull();
});
it('内部链接可包含 UUID 和非法百分号，不导致导航抛异常',()=>{
 const navigate=vi.fn();const view=render(<MarkdownPreview content={'[导入笔记](mynote:123)\n\n[百分号](mynote:100%标题)'} onNavigate={navigate}/>);
 fireEvent.click(view.getByText('导入笔记'));expect(navigate).toHaveBeenCalledWith('123');fireEvent.click(view.getByText('百分号'));expect(navigate).toHaveBeenCalledWith('100%标题');
});
