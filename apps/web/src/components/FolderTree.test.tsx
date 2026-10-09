import {render,fireEvent,cleanup} from '@testing-library/react';
import {afterEach,it,expect,vi} from 'vitest';
import {FolderTree} from './FolderTree';
import {buildFolderTree,isInFolder,flattenFolders} from '../lib/folders';
import type {NoteSummary} from '../lib/db';
const note=(id:string,parentId:string|null,deletedAt:number|null=null):NoteSummary=>({id,parentId,deletedAt,title:id,excerpt:'',indexToken:id,version:1,tags:[],favorite:false,createdAt:1,updatedAt:1});
const notes=[note('a','My Notes/Work/Deep'),note('b','My Notes/Work'),note('c','My Notes/Workshop'),note('d',null),note('e',null),note('trash','Deleted',2)];
afterEach(cleanup);
it('迁移路径还原层级，祖先计数不重复，不包含回收站，前缀相似目录不混入',()=>{
 const tree=buildFolderTree(notes);expect(tree.unfiled).toBe(2);expect(tree.roots).toHaveLength(1);
 expect(tree.roots[0].count).toBe(3);expect(tree.roots[0].children.find(n=>n.name==='Work')?.count).toBe(2);
 expect(isInFolder('My Notes/Work/Deep','My Notes/Work')).toBe(true);
 expect(isInFolder('My Notes/Workshop','My Notes/Work')).toBe(false);
 expect(isInFolder(null,'')).toBe(true);expect(isInFolder('My Notes','')).toBe(false);
});
it('展开深层目录、选择目录和未分类，选择操作不改变展开状态',()=>{
 const select=vi.fn();const ui=render(<FolderTree notes={notes} selected="My Notes/Work" onSelect={select}/>);
 expect(ui.queryByRole('button',{name:'笔记 a'})).toBeNull();
 fireEvent.click(ui.getByRole('button',{name:'展开目录 My Notes/Work'}));
 ui.rerender(<FolderTree notes={notes} selected="My Notes/Work/Deep" onSelect={select}/>);
 const deep=ui.getByRole('button',{name:'笔记 a'});expect(deep.getAttribute('aria-current')).toBe('page');fireEvent.click(deep);expect(select).toHaveBeenLastCalledWith('My Notes/Work/Deep');
 fireEvent.click(ui.getByRole('button',{name:'目录 未分类'}));expect(select).toHaveBeenLastCalledWith('');
 fireEvent.click(ui.getByRole('button',{name:'收起目录 My Notes'}));expect(ui.queryByRole('button',{name:'笔记 a'})).toBeNull();
});

it('刷新后复用展开状态，深层选中目录自动展开祖先',()=>{
 const select=vi.fn();const changed=vi.fn();
 const ui=render(<FolderTree notes={notes} selected="My Notes/Work/Deep" expanded={{'My Notes':true,'My Notes/Work':true}} onExpandedChange={changed} onSelect={select}/>);
 expect(ui.getByRole('button',{name:'笔记 a'}).getAttribute('aria-current')).toBe('page');
 fireEvent.click(ui.getByRole('button',{name:'收起目录 My Notes/Work'}));
 expect(changed).toHaveBeenCalledWith({'My Notes':true,'My Notes/Work':false});
 ui.rerender(<FolderTree notes={notes} selected="My Notes/Work/Deep" expanded={{'My Notes':true,'My Notes/Work':false}} onExpandedChange={changed} onSelect={select}/>);
 expect(ui.queryByRole('button',{name:'笔记 a'})).toBeNull();
});

it('单篇末级目录显示真实文档入口，多篇目录仍是文件夹，父目录不因总数为一变成文件',()=>{
 const open=vi.fn();const select=vi.fn();
 const data=[note('single','Books/One'),note('first','Books/Two'),note('second','Books/Two'),note('deep','Parent/Child')];
 const ui=render(<FolderTree notes={data} selected="Books/One" onSelect={select} onOpenNote={open}/>);
 const document=ui.getByRole('button',{name:'笔记 single'});expect(document.querySelector('svg')?.classList.contains('lucide-file-text')).toBe(true);
 fireEvent.click(document);expect(open).toHaveBeenCalledWith(data[0],'Books/One');expect(select).not.toHaveBeenCalled();
 expect(ui.getByRole('button',{name:'目录 Books/Two'}).querySelector('svg')?.classList.contains('lucide-folder')).toBe(true);
 expect(ui.getByRole('button',{name:'目录 Parent'}).querySelector('svg')?.classList.contains('lucide-folder')).toBe(true);
});

it('法律直属笔记与子目录合计 105 篇不重复，保险两篇可展开',()=>{
 const legal=Array.from({length:102},(_,i)=>note('legal-'+i,'法律'));
 const children=Array.from({length:3},(_,i)=>note('child-'+i,'法律/子目录'+i));
 const insurance=[note('insurance-1','保险'),note('insurance-2','保险')];
 const {roots}=buildFolderTree([...legal,...children,...insurance]);
 const rows=flattenFolders(roots,{'法律':true,'保险':true},null);
 const legalRows=rows.filter(row=>row.kind==='note'&&isInFolder(row.path,'法律'));
 expect(legalRows).toHaveLength(105);expect(new Set(legalRows.map(row=>row.key)).size).toBe(105);
 const ui=render(<FolderTree notes={insurance} selected="保险" onSelect={vi.fn()}/>);
 fireEvent.click(ui.getByRole('button',{name:'展开目录 保险'}));
 expect(ui.getByRole('button',{name:'笔记 insurance-1'})).toBeTruthy();expect(ui.getByRole('button',{name:'笔记 insurance-2'})).toBeTruthy();
});
it('7000 篇展开目录使用虚拟窗口，滚动能打开末尾笔记',()=>{
 const data=Array.from({length:7000},(_,i)=>note('bulk-'+i,'大量笔记'));
 const open=vi.fn();const ui=render(<FolderTree notes={data} selected="大量笔记" expanded={{'大量笔记':true}} onSelect={vi.fn()} onOpenNote={open}/>);
 expect(ui.container.querySelectorAll('.folder-row').length).toBeLessThan(30);
 fireEvent.scroll(ui.container.querySelector('.folder-tree')!,{target:{scrollTop:6995*28}});
 fireEvent.click(ui.getByRole('button',{name:'笔记 bulk-6999'}));expect(open).toHaveBeenCalledWith(data[6999],'大量笔记');
 expect(ui.container.querySelectorAll('.folder-row').length).toBeLessThan(30);
});
