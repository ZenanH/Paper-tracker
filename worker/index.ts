import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { store, type Store } from '../lib/db/index.ts';
import { aiReady, aiSettings } from '../lib/ai.ts';
import { enqueueSync, finishRuns, leaseTask, type Task } from '../lib/sync.ts';
import { nextScheduled } from '../lib/time.ts';
import { aiConcurrency } from '../lib/network.ts';
import { crossrefConcurrency } from '../lib/sources/crossref.ts';
import { runPool } from './pool.ts';
import { failTask, processAI, processFetch, processProjection, processWebDAVBackup } from './tasks.ts';

export async function workerTick(s: Store, turn: number, signal?: AbortSignal, onlyKind?: string, singleSlot = false) {
  const now = Date.now(), installation = s.installation();
  if (now >= installation.next_scheduled_at) {
    s.transaction(() => {
      enqueueSync(s, undefined, `${installation.instance_id}:${installation.schedule_version}:${installation.next_scheduled_at}`, now);
      s.run('UPDATE installation SET next_scheduled_at=? WHERE id=1', [nextScheduled(now, installation.schedule_hour, installation.schedule_minute)]);
    });
  }
  const kinds = onlyKind ? [onlyKind] : ['fetch', 'projection', 'filter', 'translate', 'webdav_backup'];
  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[(turn + i) % kinds.length];
    if ((kind === 'filter' || kind === 'translate') && !aiReady(aiSettings(s))) continue;
    const first = leaseTask(s, kind);
    if (!first) continue;
    const tasks: Task[] = [first];
    if (kind === 'fetch' && !singleSlot) {
      while (tasks.length < crossrefConcurrency()) {
        const more = leaseTask(s, kind); if (!more) break;
        tasks.push(more);
      }
    }
    if (kind === 'filter' || kind === 'translate') {
      let bytes = s.one<{ n: number }>('SELECT length(CAST(title_original AS BLOB)) AS n FROM paper WHERE id=?', [first.paper_id!])?.n || 0;
      while (tasks.length < (kind === 'translate' && !singleSlot ? 10 * aiConcurrency() : 10) && bytes < 12000) {
        const more = leaseTask(s, kind); if (!more) break;
        const size = s.one<{ n: number }>('SELECT length(CAST(title_original AS BLOB)) AS n FROM paper WHERE id=?', [more.paper_id!])?.n || 0;
        if (bytes + size > 24000) { s.run("UPDATE task SET state='queued',lease_owner=NULL,lease_until=NULL WHERE id=? AND lease_owner=? AND fence=?", [more.id, more.lease_owner, more.fence]); break; }
        tasks.push(more); bytes += size; if (tasks.length % 10 === 0) bytes = 0;
      }
    }
    const operation = new AbortController();
    const operationSignal = signal ? AbortSignal.any([signal, operation.signal]) : operation.signal;
    const cancellation = setInterval(() => { if (tasks.some(task => { const row = s.one<{ state: string; fence: number }>('SELECT state,fence FROM task WHERE id=?', [task.id]); return !row || row.fence !== task.fence; })) operation.abort(); }, 250);
    const renew = setInterval(() => {
      for (const task of tasks) s.run("UPDATE task SET lease_until=? WHERE id=? AND lease_owner=? AND fence=? AND state='running' AND lease_until>?", [Date.now() + 120_000, task.id, task.lease_owner, task.fence, Date.now()]);
    }, 20_000);
    try {
      if (kind === 'fetch') await Promise.all(tasks.map(async task => { try { await processFetch(s, task, operationSignal); } catch (error) { if (!operationSignal.aborted) failTask(s, task, error); } }));
      else if (kind === 'projection') processProjection(s, first);
      else if (kind === 'webdav_backup') await processWebDAVBackup(s, first, operationSignal);
      else if (kind === 'translate') {
        const batches = Array.from({ length: Math.ceil(tasks.length / 10) }, (_, i) => tasks.slice(i * 10, i * 10 + 10));
        await Promise.all(batches.map(async batch => { try { await processAI(s, batch, operationSignal); } catch (error) { for (const task of batch) failTask(s, task, error); } }));
      } else await processAI(s, tasks, operationSignal);
    } catch (error) { for (const task of tasks) failTask(s, task, error); }
    finally {
      clearInterval(renew); clearInterval(cancellation);
      if (operationSignal.aborted) s.transaction(() => {
        for (const task of tasks) s.run("UPDATE task SET state='queued',lease_owner=NULL,lease_until=NULL,fence=fence+1 WHERE id=? AND lease_owner=? AND fence=? AND state='running'", [task.id, task.lease_owner, task.fence]);
        s.touch();
      });
    }
    finishRuns(s);
    return true;
  }
  finishRuns(s);
  return false;
}
export async function runWorker() {
  const s = store(), controller = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => controller.abort());
  const heartbeat = setInterval(() => { try { s.run('UPDATE installation SET worker_heartbeat_at=? WHERE id=1', [Date.now()]); } catch { console.error('worker: 数据库心跳提交失败。'); } }, 5000);
  s.run('UPDATE installation SET worker_heartbeat_at=? WHERE id=1', [Date.now()]);
  console.log('Paper-tracker worker 已启动。');
  try {
    // Independent lanes share the durable queue and global provider limiters.
    // A slow translation batch cannot hold up journal retrieval or filtering.
    const lanes = ['fetch', 'projection', 'filter', 'translate', 'webdav_backup'].map(kind => runPool({
      slots: kind === 'fetch' || kind === 'translate' ? 3 : 1,
      capacity: () => kind === 'fetch' ? crossrefConcurrency() : kind === 'translate' ? aiConcurrency() : 1,
      signal: controller.signal,
      idleMs: 1000,
      work: (_slot, signal) => workerTick(s, 0, signal, kind, true)
    }));
    for (const lane of lanes) void lane.catch(() => controller.abort());
    const results = await Promise.allSettled(lanes);
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  } finally { clearInterval(heartbeat); s.close(); console.log('worker 已停止，进度已保留。'); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) runWorker().catch(() => { console.error('worker 启动失败，请检查外挂目录、数据库与密钥文件。'); process.exitCode = 1; });
