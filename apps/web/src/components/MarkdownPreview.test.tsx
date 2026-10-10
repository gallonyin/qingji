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

it('保留普通正文的单次换行，空行仍分隔段落',()=>{
 const view=render(<MarkdownPreview content={'nvm install 14\nnvm use 14\nnvm alias default 14\n\n下一段'} onNavigate={vi.fn()}/>);
 const paragraphs=view.container.querySelectorAll('p');
 expect(paragraphs).toHaveLength(2);
 expect(paragraphs[0].querySelectorAll('br')).toHaveLength(2);
 expect(paragraphs[0].innerHTML).toBe('nvm install 14<br>\nnvm use 14<br>\nnvm alias default 14');
 expect(paragraphs[1]).toHaveTextContent('下一段');
});
it('引用和列表项保留换行，代码块和表格结构保持正常',()=>{
 const content='> 引用第一行\n> 引用第二行\n\n- 列表第一行\n  列表第二行\n\n```sh\necho first\necho second\n```\n\n| 列一 | 列二 |\n| --- | --- |\n| 值一 | 值二 |';
 const view=render(<MarkdownPreview content={content} onNavigate={vi.fn()}/>);
 expect(view.container.querySelector('blockquote p')?.querySelectorAll('br')).toHaveLength(1);
 expect(view.container.querySelector('li')?.querySelectorAll('br')).toHaveLength(1);
 expect(view.container.querySelector('pre code')).toHaveTextContent('echo first echo second');
 expect(view.container.querySelector('pre code')?.textContent).toBe('echo first\necho second\n');
 expect(view.container.querySelector('pre br')).toBeNull();
 expect(view.container.querySelectorAll('table tbody td')).toHaveLength(2);
});
