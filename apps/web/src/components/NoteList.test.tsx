import {render,fireEvent,cleanup} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NoteList} from './NoteList';
import type {NoteSummary} from '../lib/db';
const notes:NoteSummary[]=Array.from({length:7000},(_,i)=>({id:String(i),title:`笔记 ${i}`,excerpt:'摘要内容',indexToken:String(i),tags:[],parentId:null,favorite:false,createdAt:1,updatedAt:1,deletedAt:null,version:1}));
beforeEach(()=>vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('7000 篇只挂载可见行，滚动后能选择尾部文章',()=>{
 const onOpen=vi.fn();const {container,getByText}=render(<NoteList notes={notes} selectedId="0" query="" resetKey="all" onOpen={onOpen}/>);
 expect(container.querySelectorAll('.note-row').length).toBeLessThan(30);
 fireEvent.scroll(container.querySelector('.note-list')!,{target:{scrollTop:6990*58}});
 fireEvent.click(getByText('笔记 6999'));expect(onOpen).toHaveBeenCalledWith(notes[6999]);
 expect(container.querySelectorAll('.note-row').length).toBeLessThan(30);
});
it('键盘跨窗口选择最后一篇；同步刷新不重置滚动，筛选变化才重置',()=>{
 const onOpen=vi.fn();const {container,rerender}=render(<NoteList notes={notes} selectedId="0" query="" resetKey="all" onOpen={onOpen}/>);
 const list=container.querySelector('.note-list')!;
 fireEvent.keyDown(list,{key:'End'});expect(onOpen).toHaveBeenCalledWith(notes[6999]);
 expect(list.scrollTop).toBeGreaterThan(0);
 rerender(<NoteList notes={[...notes]} selectedId="6999" query="" resetKey="all" onOpen={onOpen}/>);
 expect(list.scrollTop).toBeGreaterThan(0);
 rerender(<NoteList notes={notes.slice(0,2)} selectedId="0" query="摘要" resetKey="search" onOpen={onOpen}/>);
 expect(list.scrollTop).toBe(0);expect(container.querySelectorAll('.note-row')).toHaveLength(2);
});
it('恢复末尾选中文章时滚动到该行，仍只挂载可见窗口',()=>{
 const {container,getByText}=render(<NoteList notes={notes} selectedId="6999" query="" resetKey="all" onOpen={vi.fn()}/>);
 expect(container.querySelector('.note-list')!.scrollTop).toBeGreaterThan(0);
 expect(getByText('笔记 6999').closest('button')?.getAttribute('aria-current')).toBe('page');
 expect(container.querySelectorAll('.note-row').length).toBeLessThan(30);
});
