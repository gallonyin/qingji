#!/usr/bin/env python3
"""Read-only Joplin migration into a new Mynote vault. Standard library only.
Never writes to the source profile, uses SQLite online backup for consistency.
Destination must not exist; incomplete runs remain separate and auditable.
"""
import argparse
import collections
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import uuid

NAMESPACE = uuid.UUID('968b6b01-e5ad-4f93-af5d-f07f41054b21')
LINK = re.compile(r':/([0-9a-fA-F]{32})(?![0-9a-fA-F])')

def ident(old):
    return str(uuid.uuid5(NAMESPACE, old))

def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()

def stamp(value):
    return dt.datetime.fromtimestamp(value / 1000, dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')

def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')

def migrate(source, dest):
    source = source.resolve()
    dest = dest.resolve()
    if dest == source or source in dest.parents or dest in source.parents:
        raise ValueError('Source and destination must be separate directory trees')
    if dest.exists():
        raise ValueError('Destination already exists; refusing to overwrite')
    old_umask = os.umask(0o077)
    dest.mkdir(parents=True)
    archive = dest / 'source-archive'
    archive.mkdir()
    vault = dest / 'vault'
    (vault / 'notes').mkdir(parents=True)
    (vault / 'attachments').mkdir()
    report = {'status': 'incomplete', 'source': str(source), 'destination': str(dest),
              'startedAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'warnings': []}
    write_json(dest / 'report.json', report)
    print('Taking a consistent read-only SQLite snapshot', flush=True)
    src = sqlite3.connect((source / 'database.sqlite').as_uri() + '?mode=ro', uri=True)
    src.execute('PRAGMA query_only=ON')
    target = sqlite3.connect(archive / 'database.sqlite')
    src.backup(target, pages=4096)
    target.close()
    src.close()
    db = sqlite3.connect((archive / 'database.sqlite').as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    notes = [dict(r) for r in db.execute('select * from notes')]
    folders = {r['id']: dict(r) for r in db.execute('select * from folders')}
    resources = {r['id']: dict(r) for r in db.execute('select * from resources')}
    tags = {r['id']: r['title'] for r in db.execute('select * from tags')}
    note_tags = collections.defaultdict(list)
    for r in db.execute('select note_id,tag_id from note_tags'):
        if r['tag_id'] in tags:
            note_tags[r['note_id']].append(tags[r['tag_id']])
    associated = collections.defaultdict(set)
    for r in db.execute('select note_id,resource_id from note_resources where is_associated=1'):
        associated[r['note_id']].add(r['resource_id'])
    if any(n['encryption_applied'] or n['markup_language'] != 1 for n in notes):
        raise ValueError('Encrypted or non-Markdown notes require conversion before import')
    if any(r['encryption_applied'] or r['encryption_blob_encrypted'] for r in resources.values()):
        raise ValueError('Encrypted attachments require decryption before import')
    paths = {}
    missing_folders = set()
    def folder_path(fid, trail=()):
        if not fid:
            return ''
        if fid in paths:
            return paths[fid]
        if fid not in folders:
            missing_folders.add(fid)
            return ''
        if fid in trail:
            raise ValueError('Cyclic folder hierarchy')
        folder = folders[fid]
        name = re.sub(r'[/\\\x00-\x1f]', '_', folder['title']).strip() or '未命名笔记本'
        if name in ('.', '..'):
            name = '_' + name
        # Disambiguate only folders with identical sanitized names in one parent.
        siblings = [f for f in folders.values() if f['parent_id'] == folder['parent_id'] and
                    (re.sub(r'[/\\\x00-\x1f]', '_', f['title']).strip() or '未命名笔记本') == name]
        if len(siblings) > 1:
            name += ' [' + fid[:8] + ']'
        parent = folder_path(folder['parent_id'], (*trail, fid))
        paths[fid] = parent + '/' + name if parent else name
        return paths[fid]
    for fid in folders:
        (vault / 'notes' / folder_path(fid)).mkdir(parents=True, exist_ok=True)
    resource_files = {}
    manifests = []
    (archive / 'resources').mkdir()
    print(f'Copying and verifying {len(resources)} resources', flush=True)
    for index, (rid, resource) in enumerate(resources.items(), 1):
        ext = resource['file_extension'] or ''
        filename = rid + ('.' + ext if ext else '')
        if Path(filename).name != filename or not re.fullmatch('[0-9a-f]{32}', rid):
            raise ValueError('Unsafe attachment filename')
        original = source / 'resources' / filename
        copied = archive / 'resources' / filename
        if not original.is_file() or original.is_symlink():
            raise ValueError('Missing or symlink resource: ' + rid)
        before = digest(original)
        shutil.copyfile(original, copied)
        after = digest(copied)
        if before != after or before != digest(original):
            raise ValueError('Resource changed while copying: ' + rid)
        if resource['size'] and copied.stat().st_size != resource['size']:
            raise ValueError('Resource size mismatch: ' + rid)
        resource_files[rid] = filename
        manifests.append({'id': rid, 'filename': filename, 'bytes': copied.stat().st_size, 'sha256': after})
        if index % 5000 == 0:
            print(f'  verified {index}/{len(resources)}', flush=True)
    next_hash = {m['id']: m['sha256'] for m in manifests}
    mapping = {n['id']: ident(n['id']) for n in notes}
    note_checks = []
    unresolved = []
    attachment_count = 0
    print(f'Converting {len(notes)} notes', flush=True)
    for note in notes:
        old = note['id']
        nid = mapping[old]
        refs = set(associated[old])
        def replace(match):
            rid = match.group(1).lower()
            if rid in resources:
                refs.add(rid)
                return '/api/attachments/' + nid + '/' + resource_files[rid]
            if rid in mapping:
                return 'mynote:' + mapping[rid]
            unresolved.append({'noteId': old, 'targetId': rid})
            return match.group(0)
        content = LINK.sub(replace, note['body'])
        for rid in refs:
            if rid not in resource_files:
                raise ValueError('Missing associated resource: ' + rid)
            out = vault / 'attachments' / nid / resource_files[rid]
            out.parent.mkdir(exist_ok=True)
            # Independent copy, never hard-link original Joplin resources.
            shutil.copyfile(archive / 'resources' / resource_files[rid], out)
            if digest(out) != next_hash[rid]:
                raise ValueError('Destination attachment checksum mismatch: ' + rid)
            attachment_count += 1
        folder = folder_path(note['parent_id'])
        metadata = {'bodyFormat': 'verbatim-v1', 'id': nid, 'title': note['title'], 'tags': note_tags[old], 'folder': folder,
                    'revision': 1, 'createdAt': stamp(note['user_created_time'] or note['created_time']),
                    'updatedAt': stamp(note['user_updated_time'] or note['updated_time']),
                    'favorite': False, 'deletedAt': stamp(note['deleted_time']) if note['deleted_time'] else None,
                    'joplinId': old, 'joplinIsTodo': bool(note['is_todo']),
                    'joplinTodoDue': note['todo_due'], 'joplinTodoCompleted': note['todo_completed'],
                    'joplinSourceUrl': note['source_url'], 'joplinMarkupLanguage': note['markup_language']}
        header = '\n'.join(k + ': ' + json.dumps(v, ensure_ascii=False) for k, v in metadata.items())
        out = vault / 'notes' / folder / (nid + '.md')
        out.write_text('---\n' + header + '\n---\n' + content, encoding='utf-8')
        note_checks.append({'sourceId': old, 'id': nid, 'file': str(out.relative_to(vault)),
                            'bodySha256': hashlib.sha256(note['body'].encode()).hexdigest(),
                            'convertedBodySha256': hashlib.sha256(content.encode()).hexdigest(),
                            'fileSha256': digest(out)})
    write_json(dest / 'id-map.json', mapping)
    write_json(dest / 'resources-manifest.json', manifests)
    write_json(dest / 'notes-manifest.json', note_checks)
    write_json(dest / 'unresolved-links.json', unresolved)
    report.update(status='complete', notes=len(notes), activeNotes=sum(not n['deleted_time'] for n in notes),
                  trashedNotes=sum(bool(n['deleted_time']) for n in notes), folders=len(folders),
                  tags=len(tags), resources=len(resources), attachmentCopies=attachment_count,
                  resourceBytes=sum(m['bytes'] for m in manifests), unresolvedLinks=len(unresolved),
                  missingFolders=len(missing_folders),
                  completedAt=dt.datetime.now(dt.timezone.utc).isoformat())
    if missing_folders:
        report['warnings'].append(f'{len(missing_folders)} notes referenced missing Joplin folders and were placed at vault root')
    if unresolved:
        report['warnings'].append('Unresolved source links preserved verbatim; see unresolved-links.json')
    report['warnings'].append('Joplin history, todos and other original metadata retained in source-archive/database.sqlite; Mynote does not expose all Joplin features.')
    write_json(dest / 'report.json', report)
    db.close()
    os.umask(old_umask)
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--destination', type=Path, required=True)
    args = parser.parse_args()
    migrate(args.source, args.destination)
