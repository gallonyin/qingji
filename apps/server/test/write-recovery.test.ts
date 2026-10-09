import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {it,expect} from 'vitest';
import {MetadataDatabase} from '../src/database.js';
import {NoteStore} from '../src/note-store.js';

it('重放未完成文件提交并原子保存原操作结果，第二次启动不重复记事件',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'mynote-intent-'));
  const filename=path.join(root,'metadata.sqlite');
  let metadata=new MetadataDatabase(filename);
  try{
    const note={id:crypto.randomUUID(),title:'crash recovery',content:'完整内容',tags:[],folder:'',revision:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),favorite:false,deletedAt:null};
    const operation={id:crypto.randomUUID(),result:{note,conflict:false}};
    metadata.intent(note.id,{note,kind:'upsert',operation});
    const epoch=metadata.epoch();metadata.close();metadata=new MetadataDatabase(filename);
    const store=new NoteStore(root,metadata);await store.initialize();
    expect(store.get(note.id)).toEqual(note);
    expect(await readFile(path.join(root,'notes',`${note.id}.md`),'utf8')).toContain('完整内容');
    expect(metadata.getOperation(operation.id)).toEqual(operation.result);
    expect(metadata.intents()).toHaveLength(0);
    const cursor=metadata.latestSequence();
    metadata.close();metadata=new MetadataDatabase(filename);
    await new NoteStore(root,metadata).initialize();
    expect(metadata.latestSequence()).toBe(cursor);expect(metadata.epoch()).toBe(epoch);
  }finally{metadata.close();await rm(root,{recursive:true,force:true});}
});
