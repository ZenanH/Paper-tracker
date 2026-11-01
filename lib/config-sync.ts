import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from './db/index.ts';
import { aiReady, aiSettings } from './ai.ts';
import { nextScheduled } from './time.ts';
import { commitTask, enqueueSync, ownsTask, type Task } from './sync.ts';
import { refreshJournal } from './papers.ts';
import { AppError, decrypt, encrypt, hash } from './security.ts';
import { validISSN, type JournalInfo } from './journals/catalog.ts';
import { aiURL, ExternalError } from './network.ts';
import { WebDAVClient, validateWebDAVOptions, webdavErrorMessage, type WebDAVOptions } from './webdav-client.ts';

const zoneSchema = z.object({ zone: z.number().int().min(1).max(4).nullable(), raw: z.string().max(200), rank: z.number().int().nonnegative().nullable(), total: z.number().int().nonnegative().nullable() });
const journalInfoSchema = z.object({
  id: z.string().max(200), name: z.string().min(1).max(1000), aliases: z.array(z.string().max(1000)).max(200),
  issns: z.array(z.string().max(32)).max(32), category: z.string().max(500).nullable(), zone: zoneSchema.nullable(),
  top: z.boolean().nullable(), subjects: z.array(z.object({ name: z.string().max(500), zone: zoneSchema })).max(100),
  ifDisplay: z.string().max(100).nullable(), ifValue: z.number().finite().nullable(), ifOperator: z.enum(['<', '=']).nullable(),
  casYear: z.number().int().nullable(), ifYear: z.number().int().nullable(), ifReleaseYear: z.number().int().nullable(),
  source: z.string().max(200), invalidIssns: z.array(z.string().max(32)).max(32)
});
const journalSchema = z.object({
  catalogId: z.number().int().positive().nullable(), name: z.string().min(1).max(1000), metadata: journalInfoSchema,
  issns: z.array(z.string().regex(/^\d{4}-\d{3}[\dX]$/)).min(1).max(32), active: z.boolean(),
  filterEnabled: z.boolean(), followedAt: z.number().int().nonnegative()
});
const payloadSchema = z.object({
  formatVersion: z.literal(1),
  ai: z.object({ baseURL: z.string().max(1000), encryptedKey: z.string().max(8192).nullable(), model: z.string().max(200), filterPrompt: z.string().min(10).max(6000) }),
  crossrefEmail: z.string().max(254).refine(value => !value || z.email().safeParse(value).success),
  schedule: z.object({ hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59) }),
  journals: z.array(journalSchema).max(10_000)
});
const envelopeSchema = z.object({ formatVersion: z.literal(1), updatedAt: z.string().datetime(), encryptedPayload: z.string().min(1).max(1024 * 1024) });
const taskPayloadSchema = z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/) });
const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const WEB_DAV_LEASE_MS = 90_000;
export type ConfigurationSnapshot = z.infer<typeof payloadSchema>;
type WebDAVRow = { base_url: string; remote_path: string; username: string; encrypted_password: string | null; initialized: number; sync_direction: 'local_to_cloud' | 'cloud_to_local' };

function snapshotPayload(s: Store): ConfigurationSnapshot {
  const ai = aiSettings(s);
  const installation = s.installation();
  const journals = s.all<{ catalog_id: number | null; name: string; metadata: string; active: number; filter_enabled: number; followed_at: number; issns: string }>(`
    SELECT j.catalog_id,j.name,j.metadata,f.active,f.filter_enabled,f.followed_at,
      (SELECT group_concat(issn, char(10)) FROM (SELECT issn FROM journal_issn WHERE journal_id=j.id ORDER BY issn)) AS issns
    FROM journal j JOIN journal_follow f ON f.journal_id=j.id
    WHERE f.active=1 OR f.filter_enabled=1 ORDER BY j.id
  `).map(row => ({
    catalogId: row.catalog_id,
    name: row.name,
    metadata: JSON.parse(row.metadata) as JournalInfo,
    issns: row.issns ? row.issns.split('\n') : [],
    active: !!row.active,
    filterEnabled: !!row.filter_enabled,
    followedAt: row.followed_at
  }));
  return payloadSchema.parse({
    formatVersion: 1,
    ai: { baseURL: ai.base_url, encryptedKey: ai.encrypted_key, model: ai.model, filterPrompt: ai.filter_prompt },
    crossrefEmail: s.one<{ crossref_email: string }>('SELECT crossref_email FROM source_settings WHERE id=1')?.crossref_email ?? '',
    schedule: { hour: installation.schedule_hour, minute: installation.schedule_minute },
    journals
  });
}

function snapshotHash(payload: ConfigurationSnapshot) { return hash(JSON.stringify(payload)); }
export function configurationHash(s: Store) { return snapshotHash(snapshotPayload(s)); }
export function createCloudSnapshot(s: Store) {
  const payload = snapshotPayload(s);
  const contents = JSON.stringify({ formatVersion: 1, updatedAt: new Date().toISOString(), encryptedPayload: encrypt(JSON.stringify(payload)) });
  if (Buffer.byteLength(contents) > MAX_SNAPSHOT_BYTES) throw new AppError('The configuration backup exceeds the 1 MiB WebDAV limit.', 413, 'webdav_snapshot_too_large');
  return { hash: snapshotHash(payload), contents };
}

export function decodeCloudSnapshot(contents: string): ConfigurationSnapshot {
  if (Buffer.byteLength(contents) > 1024 * 1024) throw new AppError('WebDAV configuration backup is too large.', 400, 'webdav_snapshot_invalid');
  try {
    const envelope = envelopeSchema.parse(JSON.parse(contents));
    const decoded = decrypt(envelope.encryptedPayload, 'WebDAV 配置');
    const payload = payloadSchema.parse(JSON.parse(decoded));
    if (payload.ai.encryptedKey) decrypt(payload.ai.encryptedKey, 'AI 密钥');
    if (payload.ai.baseURL) aiURL(payload.ai.baseURL);
    const catalogIds = new Set<number>();
    const issns = new Set<string>();
    for (const journal of payload.journals) {
      if (journal.catalogId !== null && catalogIds.has(journal.catalogId)) throw new Error('duplicate catalog id');
      if (journal.catalogId !== null && journal.metadata.id !== String(journal.catalogId)) throw new Error('catalog metadata does not match identifier');
      if (journal.catalogId !== null) catalogIds.add(journal.catalogId);
      if (!journal.issns.every(validISSN)) throw new Error('invalid journal ISSN');
      for (const issn of journal.issns) { if (issns.has(issn)) throw new Error('duplicate journal ISSN'); issns.add(issn); }
    }
    return payload;
  } catch (error) {
    if (error instanceof AppError && error.code === 'encryption_key_mismatch') throw new AppError('This backup uses a different ENCRYPTION_KEY_FILE. Restore the matching instance key before downloading it.', 400, 'webdav_encryption_mismatch');
    throw new AppError('The remote file is not a valid Paper-tracker configuration backup.', 400, 'webdav_snapshot_invalid');
  }
}

function webdavRow(s: Store) { return s.one<WebDAVRow>('SELECT * FROM webdav_settings WHERE id=1')!; }

type WebDAVLease = { signal: AbortSignal; isOwned: () => boolean; assertOwned: () => void; release: () => void };
function acquireWebDAVLease(s: Store, manual: boolean, parentSignal?: AbortSignal): WebDAVLease {
  const owner = randomUUID(), now = Date.now();
  let fence = 0;
  s.transaction(() => {
    const current = s.one<{ lease_owner: string | null; lease_until: number | null; fence: number }>('SELECT lease_owner,lease_until,fence FROM config_sync WHERE id=1')!;
    if (current.lease_owner && current.lease_until !== null && current.lease_until > now) {
      if (manual) throw new AppError('A WebDAV synchronization is already running. Try again when it finishes.', 409, 'webdav_sync_busy');
      throw new ExternalError('webdav_sync_busy', true, current.lease_until);
    }
    const acquired = s.run('UPDATE config_sync SET lease_owner=?,lease_until=?,fence=fence+1 WHERE id=1 AND (lease_until IS NULL OR lease_until<=?)', [owner, now + WEB_DAV_LEASE_MS, now]);
    if (!acquired.changes) {
      if (manual) throw new AppError('A WebDAV synchronization is already running. Try again when it finishes.', 409, 'webdav_sync_busy');
      throw new ExternalError('webdav_sync_busy', true);
    }
    fence = current.fence + 1;
  });

  const controller = new AbortController();
  const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
  const isOwned = () => {
    if (signal.aborted) return false;
    const row = s.one<{ lease_owner: string | null; fence: number; lease_until: number | null }>('SELECT lease_owner,fence,lease_until FROM config_sync WHERE id=1');
    return row?.lease_owner === owner && row.fence === fence && !!row.lease_until && row.lease_until > Date.now();
  };
  const renew = setInterval(() => {
    try {
      const updated = s.run('UPDATE config_sync SET lease_until=? WHERE id=1 AND lease_owner=? AND fence=? AND lease_until>?', [Date.now() + WEB_DAV_LEASE_MS, owner, fence, Date.now()]);
      if (!updated.changes) controller.abort(new Error('WebDAV synchronization lease was lost.'));
    } catch { controller.abort(new Error('WebDAV synchronization lease could not be renewed.')); }
  }, 20_000);
  renew.unref?.();
  return {
    signal,
    isOwned,
    assertOwned() {
      if (!isOwned()) throw new ExternalError(signal.aborted ? 'webdav_sync_cancelled' : 'webdav_sync_superseded', true);
    },
    release() {
      clearInterval(renew);
      try { s.run('UPDATE config_sync SET lease_owner=NULL,lease_until=NULL WHERE id=1 AND lease_owner=? AND fence=?', [owner, fence]); }
      catch { /* Keep the persisted expiry so another operation can recover the lease. */ }
    }
  };
}

function storedWebDAVOptions(s: Store): WebDAVOptions {
  const row = webdavRow(s);
  if (!row.base_url) throw new AppError('Configure a WebDAV server first.', 400, 'webdav_not_configured');
  let password = '';
  try { if (row.encrypted_password) password = decrypt(row.encrypted_password, 'WebDAV 密码'); }
  catch { throw new AppError('The saved WebDAV password cannot be decrypted. Restore the original ENCRYPTION_KEY_FILE.', 503, 'webdav_encryption_mismatch'); }
  return { baseURL: row.base_url, remotePath: row.remote_path, username: row.username, password };
}

export function publicWebDAVSettings(s: Store) {
  const row = webdavRow(s);
  const state = s.one<{ state: string; last_attempt_at: number | null; last_success_at: number | null; last_error: string | null }>('SELECT * FROM config_sync WHERE id=1')!;
  const status = !row.base_url ? 'not_configured' : !row.initialized && state.state !== 'failed' ? 'setup_required' : state.state === 'idle' && state.last_success_at ? 'synced' : state.state;
  return {
    baseURL: row.base_url, remotePath: row.remote_path, username: row.username, hasPassword: !!row.encrypted_password,
    direction: row.sync_direction, configured: !!row.base_url, initialized: !!row.initialized, status,
    lastAttemptAt: state.last_attempt_at, lastSuccessAt: state.last_success_at,
    lastError: state.last_error ? webdavErrorMessage(state.last_error) : null
  };
}

export function saveWebDAVConnection(s: Store, input: { baseURL: string; remotePath: string; username: string; password?: string; clearCredentials?: boolean; direction: 'local_to_cloud' | 'cloud_to_local' }) {
  let changed = false;
  s.transaction(() => {
    const lock = s.one<{ lease_owner: string | null; lease_until: number | null }>('SELECT lease_owner,lease_until FROM config_sync WHERE id=1')!;
    if (lock.lease_owner && lock.lease_until !== null && lock.lease_until > Date.now()) throw new AppError('A WebDAV synchronization is already running. Try again when it finishes.', 409, 'webdav_sync_busy');
    const old = webdavRow(s);
    let oldPassword = '';
    if (old.encrypted_password) oldPassword = decrypt(old.encrypted_password, 'WebDAV 密码');
    const username = input.clearCredentials ? '' : input.username;
    const password = input.clearCredentials ? '' : input.password?.trim() ? input.password : oldPassword;
    const validated = validateWebDAVOptions({ baseURL: input.baseURL, remotePath: input.remotePath, username, password });
    const encryptedPassword = password ? (password === oldPassword ? old.encrypted_password : encrypt(password)) : null;
    changed = validated.baseURL !== old.base_url || validated.remotePath !== old.remote_path || validated.username !== old.username || encryptedPassword !== old.encrypted_password;
    s.run('UPDATE webdav_settings SET base_url=?,remote_path=?,username=?,encrypted_password=?,initialized=?,sync_direction=? WHERE id=1', [validated.baseURL, validated.remotePath, validated.username, encryptedPassword, changed ? 0 : old.initialized, input.direction]);
    if (changed) {
      s.run("UPDATE task SET state='cancelled',error_code='destination_changed',lease_owner=NULL,lease_until=NULL,fence=fence+1,updated_at=? WHERE kind='webdav_backup' AND state IN ('queued','retry','running')", [Date.now()]);
      s.run("UPDATE config_sync SET desired_hash=NULL,uploaded_hash=NULL,state='idle',last_attempt_at=NULL,last_success_at=NULL,last_error=NULL,lease_owner=NULL,lease_until=NULL,fence=fence+1 WHERE id=1");
    }
  });
  return publicWebDAVSettings(s);
}

function queueBackup(s: Store, expectedHash: string, force = false) {
  const row = webdavRow(s);
  if (!row.initialized) return;
  const sync = s.one<{ uploaded_hash: string | null }>('SELECT uploaded_hash FROM config_sync WHERE id=1')!;
  const running = s.all<{ payload: string }>("SELECT payload FROM task WHERE kind='webdav_backup' AND state='running'");
  const runningDifferent = running.some(task => {
    try { return taskPayloadSchema.parse(JSON.parse(task.payload)).hash !== expectedHash; } catch { return true; }
  });
  const active = s.one("SELECT id FROM task WHERE kind='webdav_backup' AND dedupe_key=? AND state IN ('queued','retry','running')", [`webdav-backup:${expectedHash}`]);
  if (!force && expectedHash === sync.uploaded_hash && !runningDifferent) {
    s.run("UPDATE task SET state='cancelled',fence=fence+1,lease_owner=NULL,lease_until=NULL WHERE kind='webdav_backup' AND state IN ('queued','retry') AND dedupe_key<>?", [`webdav-backup:${expectedHash}`]);
    if (!active) s.run("UPDATE config_sync SET desired_hash=?,state='idle',last_error=NULL WHERE id=1", [expectedHash]);
    return;
  }
  s.run("UPDATE task SET state='cancelled',fence=fence+1,lease_owner=NULL,lease_until=NULL WHERE kind='webdav_backup' AND state IN ('queued','retry') AND dedupe_key<>?", [`webdav-backup:${expectedHash}`]);
  const now = Date.now(), dedupeKey = `webdav-backup:${expectedHash}`;
  s.run(`INSERT INTO task(kind,dedupe_key,payload,state,created_at,updated_at) VALUES('webdav_backup',?,?,'queued',?,?)
    ON CONFLICT(dedupe_key) DO UPDATE SET state='queued',attempts=0,next_attempt_at=0,error_code=NULL,lease_owner=NULL,lease_until=NULL,fence=task.fence+1,updated_at=excluded.updated_at
    WHERE task.state IN ('succeeded','failed','cancelled')`, [dedupeKey, JSON.stringify({ hash: expectedHash }), now, now]);
  s.run("UPDATE config_sync SET desired_hash=?,state='pending',last_error=NULL WHERE id=1", [expectedHash]);
}

export function recordConfigurationChanged(s: Store) {
  if (!webdavRow(s).initialized) return;
  const update = () => queueBackup(s, configurationHash(s));
  if (s.db.isTransaction) update(); else s.transaction(update);
}

export function requestWebDAVBackupRetry(s: Store) {
  if (!webdavRow(s).initialized) throw new AppError('Connect and sync a WebDAV destination before retrying automatic backups.', 409, 'webdav_setup_required');
  s.transaction(() => queueBackup(s, configurationHash(s), true));
  return publicWebDAVSettings(s);
}

function resolveJournals(s: Store, journals: ConfigurationSnapshot['journals']) {
  return journals.map(item => {
    const byCatalog = item.catalogId === null ? undefined : s.one<{ id: number; catalog_id: number | null }>('SELECT id,catalog_id FROM journal WHERE catalog_id=?', [item.catalogId]);
    const linked = item.issns.length ? s.all<{ journal_id: number }>(`SELECT journal_id FROM journal_issn WHERE issn IN(${item.issns.map(() => '?').join(',')})`, item.issns) : [];
    const linkedIds = [...new Set(linked.map(row => row.journal_id))];
    if (linkedIds.length > 1 || (byCatalog && linkedIds.some(id => id !== byCatalog.id))) throw new AppError('The remote journal identifiers conflict with journals already stored locally.', 409, 'webdav_journal_conflict');
    const id = byCatalog?.id ?? linkedIds[0];
    if (id !== undefined) {
      const existing = s.one<{ catalog_id: number | null }>('SELECT catalog_id FROM journal WHERE id=?', [id])!;
      if (item.catalogId !== null && existing.catalog_id !== null && existing.catalog_id !== item.catalogId) throw new AppError('The remote journal catalog identifier conflicts with local data.', 409, 'webdav_journal_conflict');
      if (item.issns.some(issn => {
        const row = s.one<{ journal_id: number }>('SELECT journal_id FROM journal_issn WHERE issn=?', [issn]);
        return row && row.journal_id !== id;
      })) throw new AppError('The remote journal ISSN conflicts with local data.', 409, 'webdav_journal_conflict');
      s.run('UPDATE journal SET catalog_id=?,name=?,metadata=? WHERE id=?', [item.catalogId, item.name, JSON.stringify(item.metadata), id]);
      s.run(`DELETE FROM journal_issn WHERE journal_id=?${item.issns.length ? ` AND issn NOT IN(${item.issns.map(() => '?').join(',')})` : ''}`, [id, ...item.issns]);
      for (const issn of item.issns) s.run('INSERT OR IGNORE INTO journal_issn(issn,journal_id) VALUES(?,?)', [issn, id]);
      return { item, id, isNew: false };
    }
    const result = s.run('INSERT INTO journal(catalog_id,name,metadata) VALUES(?,?,?)', [item.catalogId, item.name, JSON.stringify(item.metadata)]);
    const newId = Number(result.lastInsertRowid);
    for (const issn of item.issns) s.run('INSERT INTO journal_issn(issn,journal_id) VALUES(?,?)', [issn, newId]);
    s.run('INSERT INTO journal_stats(journal_id) VALUES(?)', [newId]);
    return { item, id: newId, isNew: true };
  });
}

export function applyConfigurationSnapshot(s: Store, source: ConfigurationSnapshot) {
  const payload = payloadSchema.parse(source);
  if (payload.ai.encryptedKey) decrypt(payload.ai.encryptedKey, 'AI 密钥');
  if (payload.ai.baseURL) aiURL(payload.ai.baseURL);
  return s.transaction(() => {
    const resolved = resolveJournals(s, payload.journals);
    const included = new Set(resolved.map(entry => entry.id));
    const oldAI = aiSettings(s);
    const providerChanged = payload.ai.baseURL !== oldAI.base_url || payload.ai.model !== oldAI.model;
    const promptChanged = payload.ai.filterPrompt !== oldAI.filter_prompt;
    const credentialsChanged = payload.ai.encryptedKey !== oldAI.encrypted_key;
    const schedule = s.installation();
    const scheduleChanged = payload.schedule.hour !== schedule.schedule_hour || payload.schedule.minute !== schedule.schedule_minute;

    s.run('UPDATE ai_settings SET base_url=?,encrypted_key=?,model=?,filter_prompt=?,provider_version=provider_version+?,filter_prompt_version=filter_prompt_version+?,config_version=config_version+? WHERE id=1', [payload.ai.baseURL, payload.ai.encryptedKey, payload.ai.model, payload.ai.filterPrompt, +providerChanged, +promptChanged, +(providerChanged || promptChanged || credentialsChanged)]);
    s.run('INSERT INTO source_settings(id,crossref_email) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET crossref_email=excluded.crossref_email', [payload.crossrefEmail]);
    if (scheduleChanged) s.run('UPDATE installation SET schedule_hour=?,schedule_minute=?,schedule_version=schedule_version+1,next_scheduled_at=? WHERE id=1', [payload.schedule.hour, payload.schedule.minute, nextScheduled(Date.now(), payload.schedule.hour, payload.schedule.minute)]);

    const now = Date.now();
    const stale = s.all<{ journal_id: number }>('SELECT journal_id FROM journal_follow WHERE journal_id NOT IN (' + (included.size ? [...included].map(() => '?').join(',') : 'SELECT journal_id FROM journal_follow WHERE 0') + ') AND (active=1 OR filter_enabled=1)', [...included]);
    for (const row of stale) {
      s.run('UPDATE journal_follow SET active=0,unfollowed_at=CASE WHEN active=1 THEN ? ELSE unfollowed_at END,filter_enabled=0,filter_version=filter_version+(filter_enabled<>0) WHERE journal_id=?', [now, row.journal_id]);
      s.run('UPDATE paper_listing SET inbox_visible=0 WHERE journal_id=?', [row.journal_id]);
      s.run('UPDATE journal_stats SET visible_count=0,version=version+1 WHERE journal_id=?', [row.journal_id]);
    }

    const newlyActive: string[] = [];
    for (const { item, id } of resolved) {
      const old = s.one<{ active: number; filter_enabled: number; followed_at: number; unfollowed_at: number | null }>('SELECT active,filter_enabled,followed_at,unfollowed_at FROM journal_follow WHERE journal_id=?', [id]);
      const activeChanged = !old || !!old.active !== item.active;
      const filterChanged = !old || !!old.filter_enabled !== item.filterEnabled;
      const followedAt = item.followedAt || now;
      if (!old) s.run('INSERT INTO journal_follow(journal_id,active,followed_at,unfollowed_at,filter_enabled) VALUES(?,?,?,?,?)', [id, +item.active, followedAt, item.active ? null : now, +item.filterEnabled]);
      else s.run('UPDATE journal_follow SET active=?,followed_at=?,unfollowed_at=?,filter_enabled=?,filter_version=filter_version+? WHERE journal_id=?', [ +item.active, followedAt, item.active ? null : old.unfollowed_at ?? now, +item.filterEnabled, +filterChanged, id]);
      if (activeChanged || filterChanged) {
        if (!item.active) {
          s.run('UPDATE paper_listing SET inbox_visible=0 WHERE journal_id=?', [id]);
          s.run('UPDATE journal_stats SET visible_count=0,version=version+1 WHERE journal_id=?', [id]);
        }
        refreshJournal(s, String(id));
      }
      if (item.active && (!old || !old.active)) newlyActive.push(String(id));
    }

    if (providerChanged || promptChanged) {
      const settings = aiSettings(s);
      s.run("UPDATE task SET state='cancelled',lease_owner=NULL,lease_until=NULL,fence=fence+1 WHERE kind IN ('filter','translate') AND state IN ('queued','running','retry','blocked','failed')");
      s.run("INSERT OR IGNORE INTO task(kind,dedupe_key,payload,created_at,updated_at) VALUES('projection',?,'{}',?,?)", [`projection:${settings.config_version}`, now, now]);
    }
    if (providerChanged || promptChanged || credentialsChanged) {
      const ready = aiReady(aiSettings(s));
      s.run("UPDATE task SET state=?,next_attempt_at=0,lease_owner=NULL,lease_until=NULL,fence=fence+1,error_code=? WHERE kind IN ('filter','translate') AND state IN ('queued','running','retry','blocked')", [ready ? 'queued' : 'blocked', ready ? null : 'ai_not_configured']);
    }
    if (newlyActive.length) enqueueSync(s, newlyActive, undefined, now);
    s.touch(true);
    return { followed: payload.journals.filter(journal => journal.active).length };
  });
}

function recordManualFailure(s: Store, error: unknown) {
  const code = error instanceof AppError || error instanceof ExternalError ? error.code : 'webdav_connection_failed';
  s.transaction(() => s.run("UPDATE config_sync SET state='failed',last_attempt_at=?,last_error=? WHERE id=1", [Date.now(), code]));
}

function recordUploadSuccess(s: Store, uploadedHash: string) {
  s.transaction(() => {
    const currentHash = configurationHash(s), now = Date.now();
    s.run('UPDATE webdav_settings SET initialized=1 WHERE id=1');
    s.run('UPDATE config_sync SET desired_hash=?,uploaded_hash=?,state=?,last_attempt_at=?,last_success_at=?,last_error=NULL WHERE id=1', [currentHash, uploadedHash, currentHash === uploadedHash ? 'idle' : 'pending', now, now]);
    if (currentHash !== uploadedHash) queueBackup(s, currentHash);
  });
}

export async function runWebDAVSync(s: Store, direction: 'local_to_cloud' | 'cloud_to_local', signal?: AbortSignal) {
  const lease = acquireWebDAVLease(s, true, signal);
  let client: WebDAVClient | undefined;
  try {
    client = new WebDAVClient(storedWebDAVOptions(s), lease.signal);
    await client.probe();
    if (direction === 'local_to_cloud') {
      const snapshot = createCloudSnapshot(s);
      await client.put(snapshot.contents);
      lease.assertOwned();
      recordUploadSuccess(s, snapshot.hash);
    } else {
      const contents = await client.get();
      if (contents === null) throw new ExternalError('webdav_backup_missing', false);
      const payload = decodeCloudSnapshot(contents);
      lease.assertOwned();
      applyConfigurationSnapshot(s, payload);
      lease.assertOwned();
      recordUploadSuccess(s, snapshotHash(payload));
    }
    return publicWebDAVSettings(s);
  } catch (error) {
    if (lease.isOwned()) recordManualFailure(s, error);
    throw error;
  } finally {
    try { await client?.close(); }
    finally { lease.release(); }
  }
}

export function recordWebDAVTaskFailure(s: Store, task: Task, code: string, willRetry: boolean) {
  let expectedHash = '';
  try { expectedHash = taskPayloadSchema.parse(JSON.parse(task.payload)).hash; } catch { /* Treat invalid queue data as stale. */ }
  const currentHash = configurationHash(s);
  if (expectedHash !== currentHash) {
    s.run("UPDATE task SET state='cancelled',error_code='superseded',lease_owner=NULL,lease_until=NULL WHERE id=?", [task.id]);
    queueBackup(s, currentHash);
    return;
  }
  s.run('UPDATE config_sync SET state=?,last_attempt_at=?,last_error=? WHERE id=1', [willRetry ? 'retrying' : 'failed', Date.now(), code]);
}

export async function processWebDAVBackup(s: Store, task: Task, signal?: AbortSignal) {
  if (!ownsTask(s, task)) return;
  const row = webdavRow(s);
  if (!row.initialized) {
    commitTask(s, task, () => s.run("UPDATE task SET state='cancelled',lease_owner=NULL,lease_until=NULL WHERE id=?", [task.id]));
    return;
  }
  const queuedHash = taskPayloadSchema.parse(JSON.parse(task.payload)).hash;
  const currentHash = configurationHash(s);
  if (queuedHash !== currentHash) {
    commitTask(s, task, () => {
      s.run("UPDATE task SET state='cancelled',error_code='superseded',lease_owner=NULL,lease_until=NULL WHERE id=?", [task.id]);
      queueBackup(s, currentHash);
    });
    return;
  }
  const lease = acquireWebDAVLease(s, false, signal);
  let client: WebDAVClient | undefined;
  try {
    if (!ownsTask(s, task)) return;
    if (!webdavRow(s).initialized) {
      commitTask(s, task, () => s.run("UPDATE task SET state='cancelled',lease_owner=NULL,lease_until=NULL WHERE id=?", [task.id]));
      return;
    }
    const afterLeaseHash = configurationHash(s);
    if (queuedHash !== afterLeaseHash) {
      commitTask(s, task, () => {
        s.run("UPDATE task SET state='cancelled',error_code='superseded',lease_owner=NULL,lease_until=NULL WHERE id=?", [task.id]);
        queueBackup(s, afterLeaseHash);
      });
      return;
    }
    const options = storedWebDAVOptions(s), snapshot = createCloudSnapshot(s);
    client = new WebDAVClient(options, lease.signal);
    await client.probe();
    await client.put(snapshot.contents);
    lease.assertOwned();
    commitTask(s, task, () => {
      const afterHash = configurationHash(s), now = Date.now();
      s.run("UPDATE task SET state='succeeded',lease_owner=NULL,lease_until=NULL,error_code=NULL,updated_at=? WHERE id=?", [now, task.id]);
      s.run('UPDATE config_sync SET desired_hash=?,uploaded_hash=?,state=?,last_attempt_at=?,last_success_at=?,last_error=NULL WHERE id=1', [afterHash, snapshot.hash, afterHash === snapshot.hash ? 'idle' : 'pending', now, now]);
      if (afterHash !== snapshot.hash) queueBackup(s, afterHash);
    });
  } catch (error) {
    if (error instanceof ExternalError) throw error;
    if (error instanceof AppError && error.code.startsWith('webdav_')) throw new ExternalError(error.code, false);
    throw new ExternalError('webdav_connection_failed', true);
  } finally {
    try { await client?.close(); }
    finally { lease.release(); }
  }
}

export function webDAVTaskFailureMessage(code: string) { return webdavErrorMessage(code); }
