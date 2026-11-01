import { z } from 'zod';
import { store } from '../../../lib/db/index.ts';
import { AppError, checkOrigin } from '../../../lib/security.ts';
import { jsonResponse } from '../../../lib/http.ts';
import { searchCatalog } from '../../../lib/journals/catalog.ts';
import { journalSummary, updateJournalCatalog, builtinInfo, followJournal, listJournals, setFilter, setFollow } from '../../../lib/journals/service.ts';
import { verifyJournal } from '../../../lib/sources/crossref.ts';
import { archiveJournal, favoritePaper, listPapers, refreshPaper, undoArchive } from '../../../lib/papers.ts';
import { publicSettings, saveSettings, testAI } from '../../../lib/ai.ts';
import { enqueueSync } from '../../../lib/sync.ts';
import { statusSnapshot } from '../../../lib/status.ts';
import { nextScheduled } from '../../../lib/time.ts';
import { ExternalError } from '../../../lib/network.ts';
import { recordConfigurationChanged, publicWebDAVSettings, requestWebDAVBackupRetry, runWebDAVSync, saveWebDAVConnection } from '../../../lib/config-sync.ts';
import { webdavErrorMessage } from '../../../lib/webdav-client.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const id = z.string().regex(/^\d{1,18}$/);
const token = z.string().uuid();
async function input(request: Request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new AppError('需要 JSON 请求。', 415);
  const reader = request.body?.getReader();
  if (!reader) throw new AppError('请求正文为空。');
  const buffers: Uint8Array[] = []; let bytes = 0;
  try { while (true) { const item = await reader.read(); if (item.done) break; bytes += item.value.length; if (bytes > 16 * 1024) throw new AppError('请求正文过大。', 413); buffers.push(item.value); } }
  finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(Buffer.concat(buffers).toString('utf8')) as unknown; } catch { throw new AppError('JSON 格式不正确。'); }
}
async function handle(request: Request, context: { params: Promise<{ path: string[] }> }) {
  try {
    const path = (await context.params).path.join('/'), url = new URL(request.url), method = request.method;
    if (path === 'health') return jsonResponse(request, { ok: true });
    const s = store();
    if (path === 'ready') { s.installation(); return jsonResponse(request, { ready: true }); }
    if (method !== 'GET') checkOrigin(request);
    const scope = s.installation().instance_id;
    const cached = (value: unknown, maximum?: number) => jsonResponse(request, value, { privateCache: true, scope, maximum });
    if (path === 'catalog/search' && method === 'GET') return cached({ items: searchCatalog(url.searchParams.get('q') || '') });
    if (path.startsWith('catalog/') && method === 'GET') return cached(builtinInfo(id.parse(path.split('/')[1])));
    if (path === 'journals/verify' && method === 'POST') {
      const body = z.object({ issn: z.string().regex(/^\d{4}-\d{3}[\dX]$/) }).parse(await input(request));
      return jsonResponse(request, await verifyJournal(body.issn, request.signal));
    }
    if (path === 'journals/summary' && method === 'GET') return cached(journalSummary(s));
    if (path === 'journals/update' && method === 'POST') return jsonResponse(request, updateJournalCatalog(s));
    if (path === 'journals' && method === 'GET') return cached(listJournals(s, url.searchParams.get('cursor') || undefined, url.searchParams.get('all') === '1'));
    if (path === 'journals' && method === 'POST') {
      const body = z.object({ catalogId: id.optional(), issn: z.string().regex(/^\d{4}-\d{3}[\dX]$/).optional() }).parse(await input(request));
      const info = body.catalogId ? builtinInfo(body.catalogId) : body.issn ? await verifyJournal(body.issn, request.signal) : null;
      if (!info) throw new AppError('请先选择期刊并预览资料。');
      return jsonResponse(request, followJournal(s, info));
    }
    const journalMatch = path.match(/^journals\/(\d+)\/(follow|filter|archive|detail)$/);
    if (journalMatch) {
      const journalId = id.parse(journalMatch[1]), action = journalMatch[2];
      if (action === 'detail' && method === 'GET') { const row = s.one<{ metadata: string }>('SELECT metadata FROM journal WHERE id=?', [journalId]); if (!row) throw new AppError('期刊不存在。', 404); return cached(JSON.parse(row.metadata)); }
      if (method === 'POST') {
        const body = await input(request);
        if (action === 'follow') return jsonResponse(request, setFollow(s, journalId, z.object({ active: z.boolean() }).parse(body).active));
        if (action === 'filter') { const data = z.object({ enabled: z.boolean() }).parse(body); return jsonResponse(request, setFilter(s, journalId, data.enabled)); }
        if (action === 'archive') return jsonResponse(request, archiveJournal(s, journalId, z.object({ token }).parse(body).token));
      }
    }
    if (path === 'archive/undo' && method === 'POST') { const data = z.object({ operationId: token, token }).parse(await input(request)); return jsonResponse(request, undoArchive(s, data.operationId, data.token)); }
    if ((path === 'papers' || path === 'favorites') && method === 'GET') {
      const limit = z.coerce.number().int().min(1).max(20).default(20).parse(url.searchParams.get('limit') || undefined);
      const journalId = path === 'papers' && url.searchParams.has('journalId') ? id.parse(url.searchParams.get('journalId')) : undefined;
      return cached(listPapers(s, { journalId, favorites: path === 'favorites', cursor: url.searchParams.get('cursor') || undefined, page: z.coerce.number().int().min(1).max(1000000).default(1).parse(url.searchParams.get('page') || undefined), limit }));
    }
    const paperMatch = path.match(/^papers\/(\d+)(?:\/(favorite|keep))?$/);
    if (paperMatch) {
      const paperId = id.parse(paperMatch[1]), action = paperMatch[2];
      if (!action && method === 'GET') {
        const paper = s.one('SELECT CAST(p.id AS TEXT) AS id,p.title_original AS titleOriginal,l.title_zh AS titleZh,j.name AS journalName,p.published,p.date_precision AS datePrecision,p.url,p.source,l.decision,l.reason,l.ai_status AS aiStatus FROM paper p JOIN paper_listing l ON l.paper_id=p.id JOIN journal j ON j.id=p.journal_id WHERE p.id=?', [paperId]);
        if (!paper) throw new AppError('论文不存在。', 404); return cached(paper);
      }
      if (action === 'favorite' && method === 'POST') { const body = z.object({ value: z.boolean(), token }).parse(await input(request)); return jsonResponse(request, favoritePaper(s, paperId, body.value, body.token)); }
      if (action === 'keep' && method === 'POST') { s.transaction(() => { s.run("UPDATE paper_state SET manual_filter_override='keep',version=version+1 WHERE paper_id=?", [paperId]); refreshPaper(s, paperId); }); return jsonResponse(request, { ok: true }); }
    }
    if (path === 'settings/crossref' && method === 'GET') return jsonResponse(request, { email: s.one<{ crossref_email: string }>('SELECT crossref_email FROM source_settings WHERE id=1')?.crossref_email ?? '' });
    if (path === 'settings/crossref' && method === 'POST') {
      const data = z.object({ email: z.union([z.literal(''), z.email()]).transform(v => v.trim()).pipe(z.string().max(254)) }).parse(await input(request));
      s.transaction(() => {
        const old = s.one<{ crossref_email: string }>('SELECT crossref_email FROM source_settings WHERE id=1')?.crossref_email ?? '';
        if (old === data.email) return;
        s.run('INSERT INTO source_settings(id,crossref_email) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET crossref_email=excluded.crossref_email', [data.email]);
        recordConfigurationChanged(s);
      });
      return jsonResponse(request, { email: data.email });
    }
    if (path === 'settings/webdav' && method === 'GET') return jsonResponse(request, publicWebDAVSettings(s));
    if (path === 'settings/webdav' && method === 'POST') {
      const data = z.discriminatedUnion('action', [
        z.object({ action: z.literal('retry') }),
        z.object({ action: z.literal('sync'), baseURL: z.string().max(2000), remotePath: z.string().max(1024), username: z.string().max(256), password: z.string().max(4096).optional(), clearCredentials: z.boolean().optional(), direction: z.enum(['local_to_cloud', 'cloud_to_local']) })
      ]).parse(await input(request));
      if (data.action === 'retry') return jsonResponse(request, requestWebDAVBackupRetry(s));
      saveWebDAVConnection(s, data);
      return jsonResponse(request, await runWebDAVSync(s, data.direction, request.signal));
    }
    if (path === 'settings' && method === 'GET') return jsonResponse(request, publicSettings(s));
    if (path === 'settings' && method === 'POST') return jsonResponse(request, saveSettings(s, await input(request)));
    if (path === 'settings/test' && method === 'POST') return jsonResponse(request, await testAI(s, request.signal));
    if (path === 'settings/schedule' && method === 'POST') {
      const body = z.object({ hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59) }).parse(await input(request));
      s.transaction(() => {
        const current = s.installation();
        if (current.schedule_hour === body.hour && current.schedule_minute === body.minute) return;
        s.run('UPDATE installation SET schedule_hour=?,schedule_minute=?,schedule_version=schedule_version+1,next_scheduled_at=? WHERE id=1', [body.hour, body.minute, nextScheduled(Date.now(), body.hour, body.minute)]);
        recordConfigurationChanged(s);
      });
      return jsonResponse(request, { ok: true });
    }
    if (path === 'tasks/stop' && method === 'POST') {
      s.transaction(() => {
        s.run("UPDATE task SET state='cancelled',error_code='user_stopped',fence=fence+1,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE state IN ('queued','running','retry','blocked')", [Date.now()]);
        s.run("UPDATE sync_run SET state='cancelled',completed_at=? WHERE state IN ('queued','running','partial','failed')", [Date.now()]);
        s.touch();
      });
      return jsonResponse(request, statusSnapshot(s, []));
    }
    if (path === 'sync' && method === 'POST') return jsonResponse(request, { ...enqueueSync(s, undefined, undefined, Date.now(), true), summary: statusSnapshot(s, []) });
    if (path === 'status' && method === 'GET') { const ids = (url.searchParams.get('scope') || '').split(',').filter(v => /^\d{1,18}$/.test(v)).slice(0, 20); return cached(statusSnapshot(s, ids), 8 * 1024); }
    throw new AppError('接口不存在。', 404, 'not_found');
  } catch (error) {
    if (error instanceof AppError) return jsonResponse(request, { error: error.message, code: error.code }, { status: error.status });
    if (error instanceof z.ZodError) return jsonResponse(request, { error: '输入格式不正确，请检查填写内容。', code: 'validation_failed' }, { status: 400 });
    if (error instanceof ExternalError && error.code.startsWith('webdav_')) return jsonResponse(request, { error: webdavErrorMessage(error.code), code: error.code }, { status: 502 });
    if (error instanceof ExternalError) return jsonResponse(request, { error: error.code.startsWith('ai_') ? 'AI 连接或响应异常，请检查配置后重试。' : '论文来源暂时不可用，请稍后重试。', code: error.code }, { status: 502 });
    console.error('API: 请求未完成，请检查数据库、外挂目录或服务配置。');
    return jsonResponse(request, { error: '服务暂不可用，请检查数据库与外挂目录。', code: 'service_unavailable' }, { status: 503 });
  }
}
export const GET = handle;
export const POST = handle;
