import {render,fireEvent,cleanup,waitFor} from '@testing-library/react';
import {afterEach,it,expect,vi} from 'vitest';
import {ManagementDialog} from './ManagementDialog';
afterEach(cleanup);
it('destination chooser excludes source subtree and submits selected destination',async()=>{
 const submit=vi.fn().mockResolvedValue(undefined),cancel=vi.fn();
 const ui=render(<ManagementDialog request={{action:'moveFolder',path:'Work',title:'Work'}} folders={['Work','Work/Deep','Other']} onCancel={cancel} onSubmit={submit}/>);
 expect(ui.queryByRole('option',{name:'Work'})).toBeNull();expect(ui.queryByRole('option',{name:'Work/Deep'})).toBeNull();
 fireEvent.change(ui.getByLabelText('目标位置'),{target:{value:'Other'}});fireEvent.click(ui.getByRole('button',{name:'确定'}));
 await waitFor(()=>expect(submit).toHaveBeenCalledWith({name:'Work',parent:'Other'}));expect(cancel).toHaveBeenCalled();
});
it('failed operation keeps dialog open and presents error rather than silently closing',async()=>{
 const cancel=vi.fn();const ui=render(<ManagementDialog request={{action:'createFolder'}} folders={[]} onCancel={cancel} onSubmit={async()=>{throw new Error('目标文件夹已存在，请选择其他名称或位置。');}}/>);
 fireEvent.change(ui.getByLabelText('文件夹名称'),{target:{value:'Work'}});fireEvent.click(ui.getByRole('button',{name:'确定'}));
 expect(await ui.findByRole('alert')).toHaveTextContent('目标文件夹已存在');expect(cancel).not.toHaveBeenCalled();
});
it('folder deletion explicitly includes descendant note count and recovery promise',()=>{
 const ui=render(<ManagementDialog request={{action:'deleteFolder',path:'Work',count:3}} folders={[]} onCancel={vi.fn()} onSubmit={vi.fn()}/>);
 expect(ui.getByRole('dialog').textContent).toContain('3 篇笔记将移入回收站');expect(ui.queryByRole('textbox')).toBeNull();
});
