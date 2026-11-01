import type { Store } from '../db/index.ts';
import { catalogJournal, searchCatalog, validISSN, type JournalInfo } from './catalog.ts';
import { AppError, encodeCursor, decodeCursor } from '../security.ts';
import { refreshJournal } from '../papers.ts';
import { enqueueSync } from '../sync.ts';
import { recordConfigurationChanged } from '../config-sync.ts';

export function followJournal(s: Store, info: JournalInfo, queueSync = true) {
  const issns = info.issns.filter(validISSN);
  if (!issns.length) throw new AppError('期刊缺少有效刊号。');
  return s.transaction(() => {
    const existing = s.one<{ journal_id: number }>(`SELECT journal_id FROM journal_issn WHERE issn IN(${issns.map(() => '?').join(',')}) LIMIT 1`, issns);
    let id = existing?.journal_id;
    if (!id) {
      id = Number(s.run('INSERT INTO journal(catalog_id,name,metadata) VALUES(?,?,?)', [/^\d+$/.test(info.id) ? +info.id : null, info.name, JSON.stringify(info)]).lastInsertRowid);
      for (const issn of issns) s.run('INSERT INTO journal_issn VALUES(?,?)', [issn, id]);
      s.run('INSERT INTO journal_stats(journal_id) VALUES(?)', [id]);
    }
    const old = s.one<{ active: number }>('SELECT active FROM journal_follow WHERE journal_id=?', [id]);
    s.run('INSERT INTO journal_follow(journal_id,followed_at) VALUES(?,?) ON CONFLICT(journal_id) DO UPDATE SET active=1,unfollowed_at=NULL', [id, Date.now()]);
    if (!old?.active) { refreshJournal(s, String(id)); if (queueSync) enqueueSync(s, [String(id)]); s.touch(true); recordConfigurationChanged(s); }
    return { id: String(id), name: info.name, active: true };
  });
}
export function setFollow(s: Store, id: string, active: boolean) {
  const info = s.one<{ metadata: string }>('SELECT metadata FROM journal WHERE id=?', [id]);
  if (!info) throw new AppError('期刊不存在。', 404);
  if (active) return followJournal(s, JSON.parse(info.metadata));
  return s.transaction(() => {
    const changed = s.run('UPDATE journal_follow SET active=0,unfollowed_at=? WHERE journal_id=? AND active=1', [Date.now(), id]).changes > 0;
    s.run("UPDATE task SET state='cancelled',lease_owner=NULL,lease_until=NULL,fence=fence+1 WHERE journal_id=? AND state IN ('queued','retry','running') AND kind='fetch'", [id]);
    s.run('UPDATE paper_listing SET inbox_visible=0 WHERE journal_id=?', [id]);
    s.run('UPDATE journal_stats SET visible_count=0,version=version+1 WHERE journal_id=?', [id]);
    s.touch(true);
    if (changed) recordConfigurationChanged(s);
    return { id, active: false };
  });
}
export function setFilter(s: Store, id: string, enabled: boolean) {
  return s.transaction(() => {
    const old = s.one<{ filter_enabled: number }>('SELECT filter_enabled FROM journal_follow WHERE journal_id=?', [id]);
    if (!old) throw new AppError('期刊不存在。', 404);
    if (!!old.filter_enabled === enabled) return { id, enabled };
    const count = s.one<{ n: number }>('SELECT COUNT(*) AS n FROM paper p JOIN paper_state ps ON ps.paper_id=p.id WHERE p.journal_id=? AND ps.archived_at IS NULL', [id])!.n;
    s.run('UPDATE journal_follow SET filter_enabled=?,filter_version=filter_version+1 WHERE journal_id=?', [+enabled, id]);
    s.run("UPDATE task SET state='cancelled',fence=fence+1,lease_owner=NULL,lease_until=NULL WHERE journal_id=? AND kind IN ('filter','translate') AND state IN ('queued','retry','running','failed','blocked')", [id]);
    refreshJournal(s, id); s.touch(true); recordConfigurationChanged(s);
    return { id, enabled, count };
  });
}
type JournalRow = { id: string; name: string; metadata: string; active: number; filter_enabled: number; last_successful_sync_at: number | null; visible_count: number; favorite_count: number; version: number };
export function listJournals(s: Store, cursor?: string, all = false) {
  const c = cursor ? decodeCursor<{ v: number; id: string; all: boolean }>(cursor) : null;
  if (c && (c.v !== 1 || c.all !== all || !/^\d+$/.test(c.id))) throw new AppError('分页游标无效。');
  const rows = s.all<JournalRow>(`SELECT CAST(j.id AS TEXT) AS id,j.name,j.metadata,f.active,f.filter_enabled,f.last_successful_sync_at,st.visible_count,st.favorite_count,st.version FROM journal j JOIN journal_follow f ON f.journal_id=j.id JOIN journal_stats st ON st.journal_id=j.id WHERE j.id>? ${all ? '' : 'AND f.active=1'} ORDER BY j.id LIMIT 21`, [c?.id || '0']);
  const items = rows.slice(0, 20).map(row => { const info = JSON.parse(row.metadata) as JournalInfo; return { id: row.id, name: row.name, active: !!row.active, filterEnabled: !!row.filter_enabled, lastSuccessfulSyncAt: row.last_successful_sync_at, count: row.visible_count, favoriteCount: row.favorite_count, version: row.version, zone: info.zone?.zone ?? null, top: info.top, ifDisplay: info.ifDisplay, category: info.category }; });
  return { items, hasMore: rows.length > 20, nextCursor: rows.length > 20 ? encodeCursor({ v: 1, id: items.at(-1)!.id, all }) : null, viewVersion: s.installation().content_version };
}
export function builtinInfo(id: string) { const info = catalogJournal(id); if (!info) throw new AppError('内置期刊不存在。', 404); return info; }

export function journalSummary(s: Store) {
  const rows = s.all<{ metadata: string }>('SELECT j.metadata FROM journal j JOIN journal_follow f ON f.journal_id=j.id WHERE f.active=1');
  const summary = { total: rows.length, zones: [0,0,0,0], zoneUnknown: 0, top: 0, ifHigh: 0, ifMid: 0, ifLow: 0, ifUnknown: 0 };
  for (const row of rows) {
    const info = JSON.parse(row.metadata) as JournalInfo;
    const zone = info.zone?.zone;
    if (zone && zone >= 1 && zone <= 4) summary.zones[zone-1]++; else summary.zoneUnknown++;
    if (info.top === true) summary.top++;
    if (info.ifValue === null || info.ifValue === undefined) summary.ifUnknown++;
    else if (info.ifValue >= 10) summary.ifHigh++;
    else if (info.ifValue >= 5) summary.ifMid++;
    else summary.ifLow++;
  }
  return summary;
}
export function updateJournalCatalog(s: Store) {
  return s.transaction(() => {
    const rows = s.all<{ id: number; metadata: string }>('SELECT j.id,j.metadata FROM journal j JOIN journal_follow f ON f.journal_id=j.id WHERE f.active=1');
    let updated = 0, unmatched = 0;
    for (const row of rows) {
      const old = JSON.parse(row.metadata) as JournalInfo;
      const matches = new Map(old.issns.filter(validISSN).flatMap(issn => searchCatalog(issn)).map(info => [info.id,info]));
      if (matches.size !== 1) { unmatched++; continue; }
      const info = [...matches.values()][0];
      if (s.one('SELECT id FROM journal WHERE catalog_id=? AND id<>?', [info.id,row.id])) { unmatched++; continue; }
      const metadata = JSON.stringify(info);
      if (metadata !== row.metadata) {
        s.run('UPDATE journal SET metadata=?,name=?,catalog_id=? WHERE id=?', [metadata,info.name,+info.id,row.id]);
        s.run('UPDATE journal_stats SET version=version+1 WHERE journal_id=?', [row.id]); updated++;
      }
    }
    if (updated) { s.touch(true); recordConfigurationChanged(s); }
    return { checked: rows.length, updated, unmatched, summary: journalSummary(s) };
  });
}
