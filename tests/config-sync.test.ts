import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrap } from '../lib/db/index.ts';
import { applyConfigurationSnapshot, configurationHash, createCloudSnapshot, decodeCloudSnapshot, publicWebDAVSettings, recordConfigurationChanged, saveWebDAVConnection } from '../lib/config-sync.ts';
import { encrypt, decrypt } from '../lib/security.ts';
import type { JournalInfo } from '../lib/journals/catalog.ts';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'paper-config-sync-'));
  const key = join(dir, 'encryption-key');
  const previousKey = process.env.ENCRYPTION_KEY_FILE;
  writeFileSync(key, randomBytes(32).toString('hex'), { mode: 0o600 });
  process.env.ENCRYPTION_KEY_FILE = key;
  return {
    dir,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
      if (previousKey === undefined) delete process.env.ENCRYPTION_KEY_FILE;
      else process.env.ENCRYPTION_KEY_FILE = previousKey;
    }
  };
}

function info(id: string, name: string, issn: string): JournalInfo {
  return { id, name, aliases: [], issns: [issn], category: null, zone: null, top: null, subjects: [], ifDisplay: null, ifValue: null, ifOperator: null, casYear: null, ifYear: null, ifReleaseYear: null, source: 'crossref', invalidIssns: [] };
}

function addFollow(s: ReturnType<typeof bootstrap>, metadata: JournalInfo, options: { catalogId?: number | null; active?: boolean; filterEnabled?: boolean; followedAt?: number } = {}) {
  const catalogId = options.catalogId ?? null;
  const id = Number(s.run('INSERT INTO journal(catalog_id,name,metadata) VALUES(?,?,?)', [catalogId, metadata.name, JSON.stringify(metadata)]).lastInsertRowid);
  for (const issn of metadata.issns) s.run('INSERT INTO journal_issn(issn,journal_id) VALUES(?,?)', [issn, id]);
  s.run('INSERT INTO journal_stats(journal_id) VALUES(?)', [id]);
  s.run('INSERT INTO journal_follow(journal_id,active,followed_at,unfollowed_at,filter_enabled) VALUES(?,?,?,?,?)', [id, +(options.active ?? true), options.followedAt ?? 1234, options.active === false ? 1235 : null, +(options.filterEnabled ?? false)]);
  return id;
}

test('WebDAV cloud restore atomically replaces synced configuration and preserves paper state', () => {
  const f = fixture();
  const source = bootstrap(join(f.dir, 'source.sqlite'));
  const target = bootstrap(join(f.dir, 'target.sqlite'));
  try {
    const nature = info('custom-nature', 'Nature', '0028-0836');
    addFollow(source, nature, { filterEnabled: true, followedAt: 1111 });
    source.run('UPDATE ai_settings SET base_url=?,encrypted_key=?,model=?,filter_prompt=? WHERE id=1', ['https://api.example.test/v1', encrypt('source-api-key'), 'model-a', 'Preserve every paper title.']);
    source.run("INSERT INTO source_settings(id,crossref_email) VALUES(1,'papers@example.test')");
    source.run('UPDATE installation SET schedule_hour=6,schedule_minute=45 WHERE id=1');
    const remote = createCloudSnapshot(source);
    assert.equal(remote.contents.includes('source-api-key'), false);

    const localNature = addFollow(target, info('old-nature', 'Old Nature Name', '0028-0836'), { filterEnabled: false, followedAt: 2222 });
    const localOnly = addFollow(target, info('science', 'Science', '0036-8075'), { filterEnabled: true, followedAt: 3333 });
    target.run("UPDATE ai_settings SET base_url='https://old.example.test/v1',model='old-model' WHERE id=1");
    target.run("INSERT INTO source_settings(id,crossref_email) VALUES(1,'old@example.test')");
    target.run('UPDATE installation SET schedule_hour=9,schedule_minute=0 WHERE id=1');
    const paper = Number(target.run(`INSERT INTO paper(doi,journal_id,title_original,title_hash,metadata_hash,published,date_precision,date_field,published_sort,date_eligible,url,source,fetched_at,created_at)
      VALUES('10.1126/example',?,'Kept paper','title-hash','metadata-hash','2026-10-01','day','published','2026-10-01',1,'https://doi.org/10.1126/example','crossref',1,1)`, [localOnly]).lastInsertRowid);
    target.run('INSERT INTO paper_state(paper_id,archived_at,favorited_at) VALUES(?,?,?)', [paper, 50, 60]);

    applyConfigurationSnapshot(target, decodeCloudSnapshot(remote.contents));

    assert.equal(target.one<{ name: string }>('SELECT name FROM journal WHERE id=?', [localNature])!.name, 'Nature');
    assert.equal(target.one<{ active: number; filter_enabled: number; followed_at: number }>('SELECT active,filter_enabled,followed_at FROM journal_follow WHERE journal_id=?', [localNature])!.active, 1);
    const restoredNature = target.one<{ active: number; filter_enabled: number }>('SELECT active,filter_enabled FROM journal_follow WHERE journal_id=?', [localNature])!;
    const restoredLocalOnly = target.one<{ active: number; filter_enabled: number }>('SELECT active,filter_enabled FROM journal_follow WHERE journal_id=?', [localOnly])!;
    assert.equal(restoredNature.active, 1);
    assert.equal(restoredNature.filter_enabled, 1);
    assert.equal(restoredLocalOnly.active, 0);
    assert.equal(restoredLocalOnly.filter_enabled, 0);
    const preservedState = target.one<{ archived_at: number; favorited_at: number }>('SELECT archived_at,favorited_at FROM paper_state WHERE paper_id=?', [paper])!;
    assert.equal(preservedState.archived_at, 50);
    assert.equal(preservedState.favorited_at, 60);
    assert.equal(target.one<{ base_url: string; model: string; encrypted_key: string }>('SELECT base_url,model,encrypted_key FROM ai_settings WHERE id=1')!.base_url, 'https://api.example.test/v1');
    assert.equal(decrypt(target.one<{ encrypted_key: string }>('SELECT encrypted_key FROM ai_settings WHERE id=1')!.encrypted_key), 'source-api-key');
    assert.equal(target.one<{ crossref_email: string }>('SELECT crossref_email FROM source_settings WHERE id=1')!.crossref_email, 'papers@example.test');
    const restoredSchedule = target.one<{ schedule_hour: number; schedule_minute: number }>('SELECT schedule_hour,schedule_minute FROM installation WHERE id=1')!;
    assert.equal(restoredSchedule.schedule_hour, 6);
    assert.equal(restoredSchedule.schedule_minute, 45);
    assert.equal(configurationHash(target), remote.hash);
  } finally {
    source.close(); target.close(); f.cleanup();
  }
});

test('云端配置冲突时整笔恢复回滚', () => {
  const f = fixture();
  const source = bootstrap(join(f.dir, 'source.sqlite'));
  const target = bootstrap(join(f.dir, 'target.sqlite'));
  try {
    addFollow(source, info('custom-nature', 'Nature', '0028-0836'));
    addFollow(source, info('888', 'Incoming Journal', '0162-8828'), { catalogId: 888 });
    const remote = decodeCloudSnapshot(createCloudSnapshot(source).contents);

    const first = addFollow(target, info('old-nature', 'Old Nature Name', '0028-0836'));
    addFollow(target, info('999', 'Conflicting Journal', '0162-8828'), { catalogId: 999 });
    target.run("UPDATE ai_settings SET base_url='https://local.example.test/v1' WHERE id=1");

    assert.throws(() => applyConfigurationSnapshot(target, remote), /conflict/i);
    assert.equal(target.one<{ name: string }>('SELECT name FROM journal WHERE id=?', [first])!.name, 'Old Nature Name');
    assert.equal(target.one<{ base_url: string }>('SELECT base_url FROM ai_settings WHERE id=1')!.base_url, 'https://local.example.test/v1');
  } finally {
    source.close(); target.close(); f.cleanup();
  }
});

test('已初始化的 WebDAV 目标会为配置变化排入最新快照', () => {
  const f = fixture();
  const s = bootstrap(join(f.dir, 'local.sqlite'));
  try {
    s.run("UPDATE webdav_settings SET base_url='https://dav.example.test/' ,initialized=1 WHERE id=1");
    s.run('UPDATE installation SET schedule_hour=7 WHERE id=1');
    recordConfigurationChanged(s);
    const first = s.one<{ id: number; dedupe_key: string; payload: string; state: string }>("SELECT id,dedupe_key,payload,state FROM task WHERE kind='webdav_backup'")!;
    assert.equal(first.state, 'queued');
    assert.equal(JSON.parse(first.payload).hash, configurationHash(s));

    s.run('UPDATE installation SET schedule_hour=8 WHERE id=1');
    recordConfigurationChanged(s);
    assert.equal(s.one<{ state: string }>('SELECT state FROM task WHERE id=?', [first.id])!.state, 'cancelled');
    assert.equal(s.one<{ n: number }>("SELECT COUNT(*) AS n FROM task WHERE kind='webdav_backup' AND state='queued'")!.n, 1);
    assert.equal(s.one<{ state: string }>('SELECT state FROM config_sync WHERE id=1')!.state, 'pending');
  } finally { s.close(); f.cleanup(); }
});

test('WebDAV 同步方向保存在本地，后续同步可随时切换', () => {
  const f = fixture();
  const s = bootstrap(join(f.dir, 'local.sqlite'));
  try {
    s.run("UPDATE webdav_settings SET base_url='https://dav.example.test/',initialized=1 WHERE id=1");
    saveWebDAVConnection(s, { baseURL: 'https://dav.example.test/', remotePath: 'paper-tracker/config.json', username: '', direction: 'cloud_to_local' });
    assert.equal(publicWebDAVSettings(s).direction, 'cloud_to_local');
    assert.equal(s.one<{ initialized: number }>('SELECT initialized FROM webdav_settings WHERE id=1')!.initialized, 1);

    saveWebDAVConnection(s, { baseURL: 'https://dav.example.test/', remotePath: 'paper-tracker/config.json', username: '', direction: 'local_to_cloud' });
    assert.equal(publicWebDAVSettings(s).direction, 'local_to_cloud');
  } finally { s.close(); f.cleanup(); }
});

test('schema v2 数据库升级时补齐 WebDAV 同步租约字段', () => {
  const f = fixture();
  const path = join(f.dir, 'legacy.sqlite');
  let s = bootstrap(path);
  s.close();
  const legacy = new DatabaseSync(path);
  try {
    legacy.exec('ALTER TABLE config_sync DROP COLUMN lease_owner; ALTER TABLE config_sync DROP COLUMN lease_until; ALTER TABLE config_sync DROP COLUMN fence; PRAGMA user_version=2');
  } finally { legacy.close(); }
  s = bootstrap(path);
  try {
    const columns = new Set(s.all<{ name: string }>('PRAGMA table_info(config_sync)').map(column => column.name));
    assert.ok(columns.has('lease_owner'));
    assert.ok(columns.has('lease_until'));
    assert.ok(columns.has('fence'));
    assert.ok(new Set(s.all<{ name: string }>('PRAGMA table_info(webdav_settings)').map(column => column.name)).has('sync_direction'));
    assert.equal(s.one<{ user_version: number }>('PRAGMA user_version')!.user_version, 3);
  } finally { s.close(); f.cleanup(); }
});
