import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('joplin_import', Path(__file__).parents[1] / 'import-joplin.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class MigrationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        (self.source / 'resources').mkdir()
        self.destination = self.root / 'import'
        self.old_umask = os.umask(0o077)
        self.note_id = 'a' * 32
        self.resource_id = 'b' * 32
        self.body = '\n原文\n[附件](:/' + self.resource_id + ')\n[自己](:/' + self.note_id + ')\n\n'
        db = sqlite3.connect(self.source / 'database.sqlite')
        db.executescript('''
        CREATE TABLE folders (id TEXT, parent_id TEXT, title TEXT);
        CREATE TABLE notes (id TEXT, parent_id TEXT, title TEXT, body TEXT,
          encryption_applied INTEGER, markup_language INTEGER, created_time INTEGER,
          updated_time INTEGER, user_created_time INTEGER, user_updated_time INTEGER,
          deleted_time INTEGER, is_todo INTEGER, todo_due INTEGER, todo_completed INTEGER, source_url TEXT);
        CREATE TABLE resources (id TEXT, file_extension TEXT, size INTEGER, encryption_applied INTEGER, encryption_blob_encrypted INTEGER);
        CREATE TABLE tags (id TEXT, title TEXT);
        CREATE TABLE note_tags (note_id TEXT, tag_id TEXT);
        CREATE TABLE note_resources (note_id TEXT, resource_id TEXT, is_associated INTEGER);
        ''')
        db.executemany('INSERT INTO folders VALUES (?,?,?)', [('parent', '', '上层'), ('child', 'parent', '法律')])
        db.execute('INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', (self.note_id, 'child', '文章', self.body, 0, 1, 1000, 2000, 1000, 2000, 0, 1, 0, 0, 'https://example.com'))
        db.execute('INSERT INTO resources VALUES (?,?,?,?,?)', (self.resource_id, 'png', 7, 0, 0))
        db.execute('INSERT INTO tags VALUES (?,?)', ('tag', '中文'))
        db.execute('INSERT INTO note_tags VALUES (?,?)', (self.note_id, 'tag'))
        db.execute('INSERT INTO note_resources VALUES (?,?,?)', (self.note_id, self.resource_id, 1))
        db.commit()
        db.close()
        (self.source / 'resources' / (self.resource_id + '.png')).write_bytes(b'fixture')

    def tearDown(self):
        os.umask(self.old_umask)
        self.tmp.cleanup()

    def run_migration(self):
        with contextlib.redirect_stdout(io.StringIO()):
            module.migrate(self.source, self.destination)

    def fingerprints(self):
        return {str(p.relative_to(self.source)): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in self.source.rglob('*') if p.is_file()}

    def change(self, sql):
        with sqlite3.connect(self.source / 'database.sqlite') as db:
            db.execute(sql)

    def test_preserves_source_and_hierarchy_links_and_exact_body(self):
        before = self.fingerprints()
        self.run_migration()
        self.assertEqual(before, self.fingerprints())
        uid = module.ident(self.note_id)
        out = self.destination / 'vault' / 'notes' / '上层' / '法律' / (uid + '.md')
        header, body = out.read_text().split('\n---\n', 1)
        self.assertIn('bodyFormat: "verbatim-v1"', header)
        self.assertIn('tags: ["中文"]', header)
        expected = self.body.replace(':/' + self.resource_id, '/api/attachments/' + uid + '/' + self.resource_id + '.png').replace(':/' + self.note_id, 'mynote:' + uid)
        self.assertEqual(body, expected)
        attachment = self.destination / 'vault' / 'attachments' / uid / (self.resource_id + '.png')
        self.assertEqual(attachment.read_bytes(), b'fixture')
        attachment.write_bytes(b'changed')
        self.assertEqual((self.source / 'resources' / (self.resource_id + '.png')).read_bytes(), b'fixture')
        report = json.loads((self.destination / 'report.json').read_text())
        self.assertEqual(report['status'], 'complete')
        self.assertEqual(report['folders'], 2)

    def test_refuses_existing_destination(self):
        self.destination.mkdir()
        sentinel = self.destination / 'keep'
        sentinel.write_text('untouched')
        with self.assertRaisesRegex(ValueError, 'already exists'):
            self.run_migration()
        self.assertEqual(sentinel.read_text(), 'untouched')

    def test_refuses_overlapping_directory_trees(self):
        self.destination = self.source / 'import'
        with self.assertRaisesRegex(ValueError, 'separate directory trees'):
            self.run_migration()
        self.assertFalse(self.destination.exists())

    def test_encrypted_notes_fail_without_modifying_source(self):
        self.change('UPDATE notes SET encryption_applied=1')
        before = self.fingerprints()
        with self.assertRaisesRegex(ValueError, 'Encrypted'):
            self.run_migration()
        self.assertEqual(before, self.fingerprints())
        self.assertEqual(json.loads((self.destination / 'report.json').read_text())['status'], 'incomplete')

    def test_symlink_resource_is_rejected(self):
        resource = self.source / 'resources' / (self.resource_id + '.png')
        resource.unlink()
        resource.symlink_to(self.source / 'database.sqlite')
        with self.assertRaisesRegex(ValueError, 'symlink resource'):
            self.run_migration()

    def test_cyclic_hierarchy_is_rejected(self):
        self.change("UPDATE folders SET parent_id='child' WHERE id='parent'")
        with self.assertRaisesRegex(ValueError, 'Cyclic'):
            self.run_migration()

if __name__ == '__main__':
    unittest.main()
