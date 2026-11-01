import { DatabaseSync, backup } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statfsSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { decrypt } from './security.ts';
import metadata from '../package.json' with { type: 'json' };

export const BLOCK_SIZE = 16 * 1024 * 1024;
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const manifestSchema = z.object({
  formatVersion: z.literal(1), snapshotId: z.string().uuid(), createdAt: z.string().datetime(),
  appVersion: z.string(), schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]), sqliteVersion: z.string(),
  size: z.number().int().positive().safe(), sha256: sha,
  parts: z.array(z.object({ file: z.string().regex(/^part-\d{6}\.bin\.gz$/), offset: z.number().int().nonnegative().safe(), rawSize: z.number().int().positive().max(BLOCK_SIZE), compressedSize: z.number().int().positive().max(BLOCK_SIZE + 65536), rawSha256: sha, compressedSha256: sha })).min(1)
});
function space(path: string, bytes: number) {
  const fs = statfsSync(path, { bigint: true });
  if (fs.bavail * fs.bsize < BigInt(bytes)) throw new Error('磁盘空间不足，停止备份/恢复。');
}
function writeDurable(path: string, data: string | Uint8Array) {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
}
function syncDirectory(path: string) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function checkDatabase(path: string, checkKey: boolean) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (db.prepare('PRAGMA integrity_check').all().some(row => row.integrity_check !== 'ok') || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('备份数据库完整性校验失败。');
    const schemaVersion = Number(db.prepare('PRAGMA user_version').get()!.user_version);
    if (![1, 2, 3].includes(schemaVersion) || !db.prepare('SELECT installed_at FROM installation WHERE id=1').get()) throw new Error('不支持的备份数据库。');
    const key = db.prepare('SELECT encrypted_key FROM ai_settings WHERE id=1').get()?.encrypted_key;
    if (checkKey && typeof key === 'string') decrypt(key);
    return { schemaVersion: schemaVersion as 1 | 2 | 3, sqliteVersion: String(db.prepare('SELECT sqlite_version() version').get()!.version) };
  } finally { db.close(); }
}
/** Online Backup API captures WAL commits; only completed, verified snapshots are published. */
export async function createBackup(database: string, destination: string) {
  if (!existsSync(database)) throw new Error('实例数据库不存在。');
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const id = randomUUID(), partial = join(destination, id + '.partial'), target = join(destination, id);
  mkdirSync(partial, { mode: 0o700 });
  const snapshot = join(partial, 'snapshot.sqlite');
  try {
    const walSize = existsSync(database + '-wal') ? statSync(database + '-wal').size : 0;
    space(destination, (statSync(database).size + walSize) * 2 + BLOCK_SIZE * 2);
    const db = new DatabaseSync(database, { readOnly: true });
    try { db.exec('PRAGMA busy_timeout=5000'); await backup(db, snapshot); } finally { db.close(); }
    const info = checkDatabase(snapshot, false), size = statSync(snapshot).size;
    space(destination, size + BLOCK_SIZE * 2);
    const fd = openSync(snapshot, 'r'), whole = createHash('sha256');
    const parts: z.infer<typeof manifestSchema>['parts'] = [];
    try {
      for (let offset = 0; offset < size; offset += BLOCK_SIZE) {
        const raw = Buffer.alloc(Math.min(BLOCK_SIZE, size - offset));
        let n = 0;
        while (n < raw.length) { const read = readSync(fd, raw, n, raw.length - n, offset + n); if (!read) throw new Error('快照读取不完整。'); n += read; }
        whole.update(raw);
        const compressed = gzipSync(raw, { level: 6 }), file = `part-${String(parts.length + 1).padStart(6, '0')}.bin.gz`;
        writeDurable(join(partial, file), compressed);
        parts.push({ file, offset, rawSize: raw.length, compressedSize: compressed.length, rawSha256: digest(raw), compressedSha256: digest(compressed) });
      }
    } finally { closeSync(fd); }
    writeDurable(join(partial, 'manifest.json'), JSON.stringify({ formatVersion: 1, snapshotId: id, createdAt: new Date().toISOString(), appVersion: metadata.version, ...info, size, sha256: whole.digest('hex'), parts }, null, 2) + '\n');
    rmSync(snapshot);
    writeDurable(join(partial, 'COMPLETE'), id + '\n');
    syncDirectory(partial);
    renameSync(partial, target);
    syncDirectory(destination);
    return target;
  } catch (error) { rmSync(partial, { recursive: true, force: true }); throw error; }
}
/** Restore into a new data directory; never replace an online database or its WAL files. */
export function restoreBackup(source: string, destination: string) {
  const manifestPath = join(source, 'manifest.json');
  if (statSync(manifestPath).size > 16 * 1024 * 1024) throw new Error('备份清单过大。');
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
  if (readFileSync(join(source, 'COMPLETE'), 'utf8').trim() !== manifest.snapshotId) throw new Error('备份尚未完成。');
  let size = 0;
  for (const [i, part] of manifest.parts.entries()) {
    if (part.file !== `part-${String(i + 1).padStart(6, '0')}.bin.gz` || part.offset !== size || (i < manifest.parts.length - 1 && part.rawSize !== BLOCK_SIZE)) throw new Error('备份块顺序或偏移无效。');
    size += part.rawSize;
  }
  if (size !== manifest.size) throw new Error('备份总长度无效。');
  const target = resolve(destination);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  // Exclusive directory creation prevents concurrent restores and accidental overwrite.
  mkdirSync(target, { mode: 0o700 });
  const temporary = join(target, 'restore.partial');
  try {
    space(target, size + BLOCK_SIZE * 2);
    const fd = openSync(temporary, 'wx', 0o600), whole = createHash('sha256');
    try {
      for (const part of manifest.parts) {
        const path = join(source, part.file);
        if (statSync(path).size !== part.compressedSize) throw new Error(`备份块长度错误：${part.file}`);
        const compressed = readFileSync(path);
        if (digest(compressed) !== part.compressedSha256) throw new Error(`备份块校验失败：${part.file}`);
        const raw = gunzipSync(compressed, { maxOutputLength: BLOCK_SIZE });
        if (raw.length !== part.rawSize || digest(raw) !== part.rawSha256) throw new Error(`备份原始块校验失败：${part.file}`);
        whole.update(raw);
        let written = 0;
        while (written < raw.length) written += writeSync(fd, raw, written, raw.length - written);
      }
      fsyncSync(fd);
    } finally { closeSync(fd); }
    if (whole.digest('hex') !== manifest.sha256) throw new Error('备份整库校验失败。');
    checkDatabase(temporary, true);
    // Restore can resume leases after expiry; never retain the previous worker's heartbeat.
    const db = new DatabaseSync(temporary);
    try { db.exec('UPDATE installation SET worker_heartbeat_at=NULL WHERE id=1'); } finally { db.close(); }
    linkSync(temporary, join(target, 'paper-tracker.sqlite'));
    rmSync(temporary);
    syncDirectory(target);
    return join(target, 'paper-tracker.sqlite');
  } catch (error) { rmSync(target, { recursive: true, force: true }); throw error; }
}
