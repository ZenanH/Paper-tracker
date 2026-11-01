import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrap } from '../lib/db/index.ts';
import { seedDefaultJournals } from '../lib/journals/defaults.ts';

test('新实例默认关注 33 本；同一初始快照；重启不恢复取消关注', () => {
  const dir = mkdtempSync(join(tmpdir(), 'paper-defaults-')), path = join(dir, 'test.sqlite');
  let s = bootstrap(path, Date.parse('2026-10-28T01:00:00Z'), seedDefaultJournals);
  try {
    assert.equal(s.one<{ n: number }>('SELECT COUNT(*) n FROM journal_follow WHERE active=1')!.n, 33);
    assert.equal(s.one<{ n: number }>('SELECT COUNT(*) n FROM sync_run')!.n, 1);
    assert.equal(JSON.parse(s.one<{ targets: string }>('SELECT targets FROM sync_run')!.targets).length, 33);
    assert.equal(s.one<{ n: number }>("SELECT COUNT(*) n FROM task WHERE kind='fetch'")!.n, 33);
    assert.equal(s.one<{ n: number }>('SELECT COUNT(*) n FROM journal_follow WHERE filter_enabled=1')!.n, 0);
    assert.equal(s.one("SELECT id FROM journal WHERE name='Advances in Engineering Software'"), undefined);
    s.run('UPDATE journal_follow SET active=0 WHERE journal_id=1');
    const installation = s.installation(); s.close();
    s = bootstrap(path, Date.now(), seedDefaultJournals);
    assert.equal(s.one<{ active: number }>('SELECT active FROM journal_follow WHERE journal_id=1')!.active, 0);
    assert.equal(s.installation().installed_at, installation.installed_at);
    assert.equal(s.one<{ n: number }>('SELECT COUNT(*) n FROM sync_run')!.n, 1);
  } finally { s.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('既有空实例启动也不自动追加默认关注', () => {
  const dir = mkdtempSync(join(tmpdir(), 'paper-existing-')), path = join(dir, 'test.sqlite');
  let s = bootstrap(path); s.close();
  s = bootstrap(path, Date.now(), seedDefaultJournals);
  try { assert.equal(s.one<{ n: number }>('SELECT COUNT(*) n FROM journal_follow')!.n, 0); }
  finally { s.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Update 恢复失败的旧抓取，不重跑成功期刊或重置初始窗口', async () => {
 const { enqueueSync } = await import('../lib/sync.ts');
 const dir = mkdtempSync(join(tmpdir(), 'paper-resume-')), path = join(dir, 'test.sqlite');
 const s = bootstrap(path, Date.parse('2026-10-28T01:00:00Z'), seedDefaultJournals);
 try {
  const original = s.one<{ window_start: number; window_end: number }>('SELECT window_start,window_end FROM sync_run')!;
  s.run("UPDATE task SET state='succeeded'");
  s.run("UPDATE task SET state='failed',attempts=4 WHERE kind='fetch' AND journal_id=1");
  s.run("UPDATE sync_run SET state='partial'");
  enqueueSync(s, undefined, undefined, Date.parse('2026-11-03T01:00:00Z'));
  assert.equal(s.one<{ n: number }>("SELECT COUNT(*) n FROM task WHERE kind='fetch' AND state='queued'")!.n, 1);
  assert.equal(s.one<{ n: number }>("SELECT COUNT(*) n FROM task WHERE kind='fetch' AND state='succeeded'")!.n, 32);
  assert.deepEqual(s.one('SELECT window_start,window_end FROM sync_run'), original);
 } finally { s.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('手动 Update 创建从零开始的全刊进度；运行中再次请求复用任务', async () => {
 const { enqueueSync } = await import('../lib/sync.ts');
 const { statusSnapshot } = await import('../lib/status.ts');
 const dir = mkdtempSync(join(tmpdir(), 'paper-fresh-')), path = join(dir, 'test.sqlite');
 const s = bootstrap(path, Date.parse('2026-10-28T01:00:00Z'), seedDefaultJournals);
 try {
  s.run("UPDATE task SET state='succeeded'");
  s.run("UPDATE task SET state='failed' WHERE kind='fetch' AND journal_id=1");
  s.run("UPDATE sync_run SET state='partial'");
  const now = Date.parse('2026-11-03T01:00:00Z');
  const run = enqueueSync(s, undefined, undefined, now, true);
  const snapshot = statusSnapshot(s, []), papers = snapshot.stages.find(s => s.key==='fetch')!;
  assert.equal(papers.completed, 0); assert.equal(papers.total, 33);
  assert.equal(snapshot.run!.id, run.id); assert.equal(snapshot.run!.until, now);
  assert.equal(enqueueSync(s, undefined, undefined, now, true).id, run.id);
  assert.equal(s.one<{ n: number }>("SELECT COUNT(*) n FROM task WHERE kind='fetch' AND state='queued'")!.n, 33);
 } finally { s.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('期刊统计覆盖全部关注；目录 Update 不创建论文任务、不覆盖关注和过滤', async () => {
 const { journalSummary, updateJournalCatalog } = await import('../lib/journals/service.ts');
 const { configurationHash } = await import('../lib/config-sync.ts');
 const dir = mkdtempSync(join(tmpdir(), 'paper-metrics-')), path = join(dir, 'test.sqlite');
 const s = bootstrap(path, Date.now(), seedDefaultJournals);
 try {
  s.run("UPDATE webdav_settings SET base_url='https://dav.example.test/' ,initialized=1 WHERE id=1");
  s.run('UPDATE journal_follow SET filter_enabled=1 WHERE journal_id=1');
  const original = JSON.parse(s.one<{metadata:string}>('SELECT metadata FROM journal WHERE id=1')!.metadata);
  s.run('UPDATE journal SET metadata=? WHERE id=1',[JSON.stringify({...original,ifDisplay:'0',ifValue:0})]);
  const fetchTasks = s.one<{n:number}>("SELECT COUNT(*) n FROM task WHERE kind='fetch'")!.n;
  const result = updateJournalCatalog(s);
  assert.equal(result.checked,33); assert.equal(result.updated,1); assert.equal(result.unmatched,0);
  assert.equal(journalSummary(s).total,33);
  assert.equal(s.one<{n:number}>("SELECT COUNT(*) n FROM task WHERE kind='fetch'")!.n,fetchTasks);
  const backup = s.one<{state:string;payload:string}>("SELECT state,payload FROM task WHERE kind='webdav_backup'");
  assert.equal(backup?.state,'queued');
  assert.equal(JSON.parse(backup!.payload).hash,configurationHash(s));
  assert.equal(s.one<{filter_enabled:number}>('SELECT filter_enabled FROM journal_follow WHERE journal_id=1')!.filter_enabled,1);
  s.run('UPDATE journal_follow SET active=0 WHERE journal_id=1'); assert.equal(journalSummary(s).total,32);
 } finally {s.close();rmSync(dir,{recursive:true,force:true});}
});
