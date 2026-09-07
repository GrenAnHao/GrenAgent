import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WikiFiles } from './wikiFiles';
import { WikiLibraryStore } from './wikiLibraryStore';
import { WikiSourceStore } from './wikiSourceStore';
import { WikiStore } from './wikiStore';

export function libraryFixture() {
  const root = mkdtempSync(join(tmpdir(), 'wiki-storage-test-'));
  const db = new DatabaseSync(join(root, 'fixture.sqlite'));
  const files = new WikiFiles(join(root, 'buckets'));
  const libraries = new WikiLibraryStore(db, files);
  return { root, db, files, libraries, cleanup: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

export function sourceFixture() {
  const fixture = libraryFixture();
  const sources = new WikiSourceStore(fixture.db, fixture.files, fixture.libraries);
  return { ...fixture, sources };
}

export function pageFixture() {
  const fixture = sourceFixture();
  const pages = new WikiStore(fixture.db, fixture.files.root, { libraries: fixture.libraries, sources: fixture.sources });
  const library = fixture.libraries.create({ name: 'Knowledge', description: '', bindings: ['/project'] });
  return { ...fixture, pages, library };
}
