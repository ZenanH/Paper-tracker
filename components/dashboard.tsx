'use client';
import { journalName } from './journal-name';
import { paperTitle } from './paper-title';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Icon, Mark, type IconName } from './icon';
import { api } from './client-api';
import { JournalSummary } from './journal-summary';
import { JournalSearch } from './journal-search';
import { Progress, type Status } from './progress';
import { Toasts, type Notice } from './toasts';
import { Settings } from './settings';
import { useLiquidGlass } from './use-liquid-glass';
import { StickyJournal } from './sticky-journal';
import { APP_VERSION } from '../lib/version';

type View = 'inbox' | 'favorites' | 'journals' | 'settings';
type Journal = { id: string; name: string; active: boolean; filterEnabled: boolean; lastSuccessfulSyncAt: number | null; count: number; favoriteCount: number; version: number; zone: number | null; top: boolean | null; ifDisplay: string | null; category: string | null };
type Paper = { id: string; journalId: string; journalName: string; titleOriginal: string; titleZh: string | null; published: string | null; datePrecision: string; favorite: boolean; archived: boolean; aiStatus: string; url: string; titleTruncated: boolean };
type Page<T> = { journals?: Journal[]; items: T[]; hasMore: boolean; nextCursor: string | null; viewVersion: number; page?: number; totalPages?: number };
const aiLabels: Record<string, string> = { needs_config: 'AI not configured', filtering: 'Filtering pending', translating: 'Translation pending', failed: 'AI failed', excluded: 'Filtered', skipped: '' };

export function Dashboard() {
  const toolbar = useLiquidGlass();
  // Prevent clicks on SSR controls before slow-network hydration attaches handlers.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => { setHydrated(true); }, []);
  const [view, setView] = useState<View>('journals');
  const [journals, setJournals] = useState<Journal[]>([]), [journalCursor, setJournalCursor] = useState<string | null>(null), [selected, setSelected] = useState<string | null>(null);
  const [paperJournals, setPaperJournals] = useState<Journal[]>([]);
  const [papers, setPapers] = useState<Paper[]>([]), [paperPage, setPaperPage] = useState(1), [totalPages, setTotalPages] = useState(1), [loading, setLoading] = useState(false), [loadError, setLoadError] = useState('');
  const [adding, setAdding] = useState(false), [status, setStatus] = useState<Status | null>(null), [stale, setStale] = useState(false), [lastChecked, setLastChecked] = useState<number | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]), [syncing, setSyncing] = useState(false);
  const [confirmation, setConfirmation] = useState<{ message: string; action: () => Promise<void> } | null>(null), [confirming, setConfirming] = useState(false);
  const [detail, setDetail] = useState<{ titleOriginal: string; titleZh: string | null; journalName: string; published: string | null; source: string; reason: string | null; url: string } | null>(null);
  const lastVersion = useRef<number | null>(null), requestVersion = useRef(0), statusRef = useRef<Status | null>(null);
  const notify = useCallback((notice: Omit<Notice, 'id'>) => setNotices(old => [...old, { ...notice, id: crypto.randomUUID() }]), []);
  const removeNotice = useCallback((id: string) => setNotices(old => old.filter(n => n.id !== id)), []);
  const confirm = useCallback((message: string, action: () => Promise<void>) => setConfirmation({ message, action }), []);

  const [pendingData, setPendingData] = useState(0), [journalsReady, setJournalsReady] = useState(false);
  const loadJournals = useCallback(async (cursor?: string) => {
    setPendingData(n => n + 1);
    try {
    const result = await api<Page<Journal>>(`journals?all=${view === 'journals' || view === 'settings' ? '1' : '0'}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    setJournals(old => {
      if (cursor) return [...old, ...result.items.filter(r => !old.some(o => o.id === r.id))];
      const retained = view === 'inbox' ? old.find(j => j.id === selected && j.active && !result.items.some(r => r.id === j.id)) : undefined;
      return retained ? [...result.items, retained] : result.items;
    });
    setJournalCursor(result.nextCursor);
    setSelected(old => old && (result.items.some(j => j.id === old && j.active) || !result.items.some(j => j.id === old)) ? old : cursor ? old : result.items.find(j => j.active)?.id || null);
    setJournalsReady(true);
    } finally { setPendingData(n => n - 1); }
  }, [view, selected, paperPage]);
  const journalEnd = useRef<HTMLDivElement>(null), loadingMoreJournals = useRef(false);
  useEffect(() => {
    const node = journalEnd.current;
    if (view !== 'journals' || !node || !journalCursor) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting || loadingMoreJournals.current) return;
      loadingMoreJournals.current = true;
      void loadJournals(journalCursor).catch(e => setLoadError(e.message)).finally(() => { loadingMoreJournals.current = false; });
    }, { rootMargin: '200px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [view, journalCursor, loadJournals]);
  const loadPapers = useCallback(async () => {
    const version = ++requestVersion.current;
    if (view !== 'favorites' && (view !== 'inbox')) { setPapers([]); setTotalPages(1); return; }
    setLoading(true); setLoadError('');
    try {
      const path = view === 'favorites' ? 'favorites?' : 'papers?';
      const result = await api<Page<Paper>>(`${path}limit=20&page=${paperPage}`);
      if (version !== requestVersion.current) return;
      setPaperJournals(result.journals || []); setPapers(result.items); setTotalPages(result.totalPages || 1); if (result.page && result.page !== paperPage) setPaperPage(result.page);
    } catch (e) { if (version === requestVersion.current) setLoadError((e as Error).message); }
    finally { if (version === requestVersion.current) setLoading(false); }
  }, [view, paperPage]);
  useEffect(() => { setPaperPage(1); }, [view, selected]);
  useEffect(() => { loadJournals().catch(e => setLoadError(e.message)); }, [loadJournals]);
  useEffect(() => { void loadPapers(); }, [loadPapers]);
  const refresh = useCallback(async () => {
    await Promise.all([loadJournals(), loadPapers(), (async () => {
      const snapshot = await api<Status>('status', { uncached: true });
      if (statusRef.current && snapshot.progressVersion < statusRef.current.progressVersion) return;
      setStatus(snapshot); statusRef.current = snapshot; setStale(false); setLastChecked(Date.now());
    })()]);
  }, [loadJournals, loadPapers]);
  const scope = journals.slice(0, 20).map(j => j.id).join(',');
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>, controller: AbortController | null = null, failures = 0;
    async function poll() {
      if (stopped || document.hidden || !navigator.onLine || controller) return;
      controller = new AbortController();
      try {
        const snapshot = await api<Status>(`status?scope=${scope}`, { signal: controller.signal });
        if (stopped) return;
        if (statusRef.current && snapshot.progressVersion < statusRef.current.progressVersion) return;
      setStatus(snapshot); statusRef.current = snapshot; setStale(false); setLastChecked(Date.now()); failures = 0;
        if (lastVersion.current !== null && lastVersion.current !== snapshot.contentVersion) await refresh();
        lastVersion.current = snapshot.contentVersion;
      } catch (e) { if (!stopped) { setStale(true); failures++;  } }
      finally { controller = null; if (!stopped && !document.hidden) timer = setTimeout(poll, failures ? Math.min(120000, 15000 * 2 ** failures) : statusRef.current?.active ? 3000 : 60000); }
    }
    function resume() { clearTimeout(timer); if (document.hidden || !navigator.onLine) { controller?.abort(); if (!navigator.onLine) setStale(true); return; } void refresh().catch(() => { if (!stopped) setStale(true); }).finally(() => { if (!stopped) void poll(); }); }
    void poll(); document.addEventListener('visibilitychange', resume); window.addEventListener('online', resume); window.addEventListener('offline', resume);
    return () => { stopped = true; clearTimeout(timer); controller?.abort(); document.removeEventListener('visibilitychange', resume); window.removeEventListener('online', resume); window.removeEventListener('offline', resume); };
  }, [scope, refresh]);
  const [missingConfig, setMissingConfig] = useState<string[] | null>(null);
  async function sync(skip = false) {
    setSyncing(true); try {
      if (!skip) {
        const [ai, crossref] = await Promise.all([
          api<{ baseURL: string; model: string; hasKey: boolean }>('settings', { uncached: true }),
          api<{ email: string }>('settings/crossref', { uncached: true })
        ]);
        const missing = [!crossref.email.trim() && 'Crossref email', !ai.baseURL.trim() && 'API base URL', !ai.hasKey && 'API key', !ai.model.trim() && 'Model'].filter(Boolean) as string[];
        if (missing.length) { setMissingConfig(missing); return; }
      }
      const result = await api<{ id: string | null; reused: boolean; summary: Status }>('sync', { body: {} }); setStatus(result.summary); statusRef.current = result.summary; notify({ message: result.id ? result.summary.updating ? 'Update queued.' : 'Update needs attention. Check progress.' : 'Follow a journal first.' }); } catch (e) { notify({ message: (e as Error).message, tone: 'error' }); } finally { setSyncing(false); }
  }
  const [stopping, setStopping] = useState(false);
  async function stop() {
    setStopping(true);
    try { const snapshot = await api<Status>('tasks/stop', { body: {} }); setStatus(snapshot); statusRef.current = snapshot; notify({ message: 'Update stopped. Saved results retained.' }); }
    catch (e) { notify({ message: (e as Error).message, tone: 'error' }); }
    finally { setStopping(false); }
  }
  const updating = syncing || !status || stale || status.updating;
  async function favorite(paper: Paper) {
    if (updating) return;
    const value = !paper.favorite, token = crypto.randomUUID();
    setPapers(old => old.map(p => p.id === paper.id ? { ...p, favorite: value } : p));
    try { await api(`papers/${paper.id}/favorite`, { body: { value, token } }); notify({ message: value ? 'Starred. Saved to Favorites.' : 'Unstarred.' }); if (view === 'favorites' && !value) setPapers(old => old.filter(p => p.id !== paper.id)); }
    catch (e) { setPapers(old => old.map(p => p.id === paper.id ? { ...p, favorite: paper.favorite } : p)); notify({ message: (e as Error).message, tone: 'error' }); }
  }
  async function archive(journal: Journal) {
    if (updating) return;
    try {
      const result = await api<{ count: number; operationId: string; undoExpiresAt: number }>(`journals/${journal.id}/archive`, { body: { token: crypto.randomUUID() } });
      notify({ message: `Archived ${result.count} papers from ${journalName(journal.name)}, including hidden items. Starred papers are retained.`, duration: 8000, action: { label: 'Undo archive', expiresAt: result.undoExpiresAt, run: async () => { const undone = await api<{ count: number }>('archive/undo', { body: { operationId: result.operationId, token: crypto.randomUUID() } }); notify({ message: `Restored ${undone.count} papers from this archive operation.` }); await refresh(); } } });
      await refresh();
    } catch (e) { notify({ message: (e as Error).message, tone: 'error' }); }
  }
  async function follow(journal: Journal) {
    try { await api(`journals/${journal.id}/follow`, { body: { active: !journal.active } }); notify({ message: journal.active ? `Unfollowed ${journalName(journal.name)}. Favorites and archive history are retained.` : `Following ${journalName(journal.name)} again.` }); await refresh(); }
    catch (e) { notify({ message: (e as Error).message, tone: 'error' }); }
  }
  async function toggleFilter(journal: Journal) {
    try { await api(`journals/${journal.id}/filter`, { body: { enabled: !journal.filterEnabled } }); notify({ message: journal.filterEnabled ? 'Filtering disabled. Restoring eligible papers.' : 'Title filtering enabled for this journal.' }); await refresh(); }
    catch (e) { notify({ message: (e as Error).message, tone: 'error' }); }
  }
  const dataLoading = !status || !journalsReady || pendingData > 0 || loading;
  return <div className="app-shell" inert={!hydrated}>
    <div className="main-shell"><header ref={toolbar} className="workspace-toolbar liquid-glass"><a className="toolbar-brand" href="/" aria-label="Paper-tracker home"><span className="brand-mark"><Mark /></span><span className="toolbar-wordmark">Paper-tracker</span><span className="toolbar-version">{APP_VERSION}</span></a><nav className="toolbar-navigation" aria-label="Main navigation" onKeyDown={() => { if (toolbar.current) toolbar.current.dataset.input = 'keyboard'; }} onPointerDown={() => { if (toolbar.current) toolbar.current.dataset.input = 'pointer'; }}><span aria-hidden="true" className="toolbar-selection" style={{ transform: `translateX(${({ journals: 0, inbox: 1, favorites: 2, settings: 0 }[view]) * 100}%)`, opacity: view === 'settings' ? 0 : 1 }}/>{(['journals', 'inbox', 'favorites'] as View[]).map(id => <button key={id} aria-current={view === id ? 'page' : undefined} className={view === id ? 'selected' : ''} onClick={() => { setView(id); setAdding(false); }}>{id === 'journals' ? 'Journal' : id === 'inbox' ? 'New papers' : 'Favorites'}</button>)}</nav><div className="toolbar-end"><time aria-busy={dataLoading} className={`toolbar-update-time ${dataLoading ? 'is-loading' : ''}`} dateTime={status?.lastUpdateAt ? new Date(status.lastUpdateAt).toISOString() : undefined} title="Last paper update · Beijing time">{loadError || stale ? 'Load failed' : dataLoading ? 'Loading…' : status?.lastUpdateAt ? new Date(status.lastUpdateAt).toLocaleString('en-US', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—'}</time><button className={`icon-button toolbar-settings ${view === 'settings' ? 'selected' : ''}`} aria-label="Settings" aria-current={view === 'settings' ? 'page' : undefined} onClick={() => { setView('settings'); setAdding(false); }}><Icon name="settings" size={19}/></button></div></header>
      <main className="main-content">
        {(view === 'journals' || view === 'inbox') && <section className="page-activity" aria-label="Activity">{view === 'journals' ? <JournalSummary version={status?.contentVersion || 0} search={() => setAdding(v => !v)} changed={refresh} notify={notify}/> : <Progress hideJournals={view === 'inbox'} actions={<><button className="button secondary update-button" disabled={updating} aria-busy={syncing || !!status?.updating} onClick={() => void sync()}><Icon name="sync" size={15}/><span>Update</span></button><button className="button secondary" disabled={stopping || !status?.updating} onClick={() => void stop()}>{stopping ? 'Stopping…' : 'Stop'}</button></>} status={status} stale={stale} lastChecked={lastChecked}/>}</section>}<Toasts notices={notices} remove={removeNotice}/><div className="workspace"><div className="reading-pane">
          {adding && <JournalSearch followed={new Set(journals.filter(j => j.active).map(j => j.name))} close={() => setAdding(false)} done={async name => { notify({ message: `Following ${name}. Paper sync is queued.` }); await refresh(); const next = await api<Status>(`status?scope=${scope}`); setStatus(next); }} />}
          {view === 'settings' ? <Settings notify={notify} changed={() => void refresh()} confirm={confirm}/> : view === 'journals' ? <>
            
            {!journals.length && <Empty icon="journals" title="No journals yet" description="Add a journal to start." action={() => setAdding(true)} />}
            <div className="journal-management">{journals.map(j => <section className="managed-journal" key={j.id}><div className="managed-journal-top"><span className="journal-monogram">{journalName(j.name).slice(0, 1)}</span><div className="managed-title"><h2>{j.active ? <button className="journal-open" onClick={() => { setSelected(j.id); setView('inbox'); }} aria-label={`View papers from ${journalName(j.name)}`}>{journalName(j.name)}</button> : journalName(j.name)}</h2><Tags journal={j}/></div><div className="managed-journal-actions"><label className="filter-toggle"><input type="checkbox" checked={j.filterEnabled} onChange={() => toggleFilter(j)} /><span className="switch"/><span>AI title filtering</span></label><button className={`button small ${j.active ? 'secondary' : 'primary'}`} onClick={() => follow(j)}>{j.active ? 'Unfollow' : 'Follow again'}</button></div></div>{!j.active && <div className="managed-journal-bottom"><span>Unfollowed</span></div>}</section>)}</div>
            <div ref={journalEnd} aria-hidden="true"/>
          </> : <>

            {loadError && <div className="inline-error" role="alert">{loadError}<button className="text-button" onClick={() => void refresh()}>Reload</button></div>}
            {loading && papers.length === 0 ? <div className="list-loading" role="status">Loading papers…</div> : papers.length === 0 ? <Empty icon={view === 'favorites' ? 'star' : journals.length ? 'inbox' : 'book'} title={view === 'favorites' ? 'No favorites yet' : journals.length ? 'No unread papers yet' : 'Start with a journal'} description={view === 'favorites' ? 'Star papers to save them here.' : journals.length ? 'New papers appear after syncing.' : 'Follow journals to track new papers.'} action={journals.length || view === 'favorites' ? undefined : () => setAdding(true)} /> : <div className="paper-list">{Object.values(papers.reduce<Record<string, Paper[]>>((groups, paper) => { (groups[view === 'inbox' ? paper.journalId : 'favorites'] ||= []).push(paper); return groups; }, {})).flat().map((paper, index, visiblePapers) => <Fragment key={paper.id}>{view === 'inbox' && (index === 0 || visiblePapers[index - 1].journalId !== paper.journalId) && (() => { const current = paperJournals.find(j => j.id === paper.journalId) || journals.find(j => j.id === paper.journalId) || { id: paper.journalId, name: paper.journalName, zone: null, top: null, ifDisplay: null } as Journal; return <StickyJournal><div className="current-journal-info"><span className="journal-monogram">{journalName(current.name).slice(0, 1)}</span><div><h2>{journalName(current.name)}</h2><Tags journal={current}/></div></div><button className="archive-button" disabled={updating} onClick={() => archive(current)} title="Archive all stored papers for this journal, including unloaded, filtered, and starred papers"><Icon name="archive" size={15}/><span>Archive all</span></button></StickyJournal>; })()}<article className="paper-row" key={paper.id}><span className="paper-number">{String((paperPage - 1) * 20 + index + 1).padStart(2, '0')}</span><div className="paper-content"><div className="paper-meta">{view === 'favorites' && <span className="favorite-journal" title={journalName(paper.journalName)}>{journalName(paper.journalName)}</span>}<time>{paper.published || 'Date unverified'}</time>{paper.archived && <span className="tiny-tag">Archived</span>}{paper.aiStatus !== 'ready' && aiLabels[paper.aiStatus] && <span className="ai-label">{aiLabels[paper.aiStatus]}</span>}</div><h3><a href={paper.url} target="_blank" rel="noreferrer">{paperTitle(paper.titleZh || paper.titleOriginal)}<Icon name="external" size={14}/></a></h3>{paper.titleZh && <p className="original-title">{paperTitle(paper.titleOriginal)}</p>}{paper.titleTruncated && <button className="text-button" onClick={async () => { try { setDetail(await api(`papers/${paper.id}`)); } catch (e) { notify({ message: (e as Error).message, tone: 'error' }); } }}>View full title</button>}</div><button className={`icon-button favorite-button ${paper.favorite ? 'is-favorite' : ''}`} aria-label={paper.favorite ? 'Unstar paper' : 'Star paper'} aria-pressed={paper.favorite} disabled={updating} onClick={() => favorite(paper)}><Icon name="star" size={20}/></button></article></Fragment>)}</div>}
            {totalPages > 1 && <nav className="paper-pagination" aria-label="Paper pages"><button className="button secondary" disabled={loading || paperPage === 1} onClick={() => setPaperPage(p => p - 1)}>Previous</button>{[...new Set([1, ...Array.from({ length: 5 }, (_, i) => paperPage + i - 2).filter(p => p > 1 && p < totalPages), totalPages])].sort((a,b) => a-b).map((page, i, pages) => <span key={page}>{i > 0 && page - pages[i-1] > 1 && <span className="pagination-gap">…</span>}<button className={`button ${page === paperPage ? 'primary' : 'secondary'}`} aria-label={`Page ${page}`} aria-current={page === paperPage ? 'page' : undefined} disabled={loading} onClick={() => setPaperPage(page)}>{page}</button></span>)}<button className="button secondary" disabled={loading || paperPage === totalPages} onClick={() => setPaperPage(p => p + 1)}>Next</button></nav>}
          </>}
        </div></div>
      </main>
    </div>
    {confirmation && <Dialog title="Review processing scope" close={() => !confirming && setConfirmation(null)}><p>{confirmation.message}</p><div className="form-actions"><button className="button secondary" disabled={confirming} onClick={() => setConfirmation(null)}>Cancel</button><button className="button primary" disabled={confirming} onClick={async () => { setConfirming(true); try { await confirmation.action(); setConfirmation(null); } catch (e) { notify({ message: (e as Error).message, tone: 'error' }); } finally { setConfirming(false); } }}>{confirming ? 'Processing…' : 'Confirm'}</button></div></Dialog>}
    {missingConfig && <Dialog title="Configuration incomplete" close={() => setMissingConfig(null)}><p>Missing: {missingConfig.join(', ')}.</p><p className="muted">You can still fetch papers. AI features need a complete AI configuration.</p><div className="form-actions"><button className="button secondary" onClick={() => { setMissingConfig(null); void sync(true); }}>Skip and update</button><button className="button primary" onClick={() => { setMissingConfig(null); setView('settings'); setAdding(false); }}>Settings</button></div></Dialog>}
    {detail && <Dialog title="Paper title" close={() => setDetail(null)}><h3 className="detail-title">{paperTitle(detail.titleZh || detail.titleOriginal)}</h3>{detail.titleZh && <p>{paperTitle(detail.titleOriginal)}</p>}<p className="muted">{journalName(detail.journalName)} · {detail.published || 'Date unverified'}</p>{detail.reason && <p>Filter reason: {detail.reason}</p>}<a className="button secondary" href={detail.url} target="_blank" rel="noreferrer">Read original <Icon name="external" size={14}/></a></Dialog>}
  </div>;
}
function Tags({ journal }: { journal: Journal }) { return <span className="journal-tags"><span className="tag">{journal.zone ? `中科院 ${journal.zone} 区` : '暂无中科院分区'}</span>{journal.top === true && <span className="tag top-tag">TOP</span>}<span className="tag if-tag">IF {journal.ifDisplay || '—'}</span></span>; }
function Empty({ icon, title, description, action }: { icon: IconName; title: string; description: string; action?: () => void }) { return <div className="empty-state"><div className="empty-illustration"><span className="empty-ring ring-one"/><span className="empty-ring ring-two"/><span className="empty-icon"><Icon name={icon} size={34}/></span><span className="empty-dot dot-one"/><span className="empty-dot dot-two"/></div><h2>{title}</h2><p>{description}</p>{action && <button className="button empty-action" onClick={action}>Add journal <Icon name="arrow" size={16}/></button>}</div>; }
function Dialog({ title, close, children }: { title: string; close: () => void; children: React.ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const node = dialog.current!; const previous = document.activeElement as HTMLElement; node.showModal(); return () => { node.close(); previous?.focus(); }; }, []);
  return <dialog className="dialog" ref={dialog} onCancel={e => { e.preventDefault(); close(); }} aria-label={title}><div className="panel-heading"><h2>{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={close}><Icon name="close"/></button></div>{children}</dialog>;
}
