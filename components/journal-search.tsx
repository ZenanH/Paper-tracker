'use client';
import { journalName } from './journal-name';
import { useEffect, useRef, useState } from 'react';
import type { JournalInfo } from '../lib/journals/catalog';
import { api } from './client-api';
import { Icon } from './icon';

export function JournalSearch({ followed, close, done }: { followed: Set<string>; close: () => void; done: (name: string) => Promise<void> }) {
  const [query, setQuery] = useState(''), [items, setItems] = useState<JournalInfo[]>([]), [selected, setSelected] = useState<JournalInfo | null>(null);
  const [searching, setSearching] = useState(false), [following, setFollowing] = useState(false), [error, setError] = useState(''), [searched, setSearched] = useState(false);
  const latest = useRef(0);
  async function search(text: string, signal?: AbortSignal) {
    const version = ++latest.current;
    if (text.trim().length < 2) { setItems([]); setSearching(false); setSearched(false); return; }
    setSearching(true); setError('');
    try {
      const result = await api<{ items: JournalInfo[] }>(`catalog/search?q=${encodeURIComponent(text.trim())}`, { signal });
      if (version !== latest.current) return; setItems(result.items); setSearched(true);
    } catch (e) { if (e instanceof Error && e.name !== 'AbortError' && version === latest.current) setError(e.message); }
    finally { if (version === latest.current) setSearching(false); }
  }
  useEffect(() => { const controller = new AbortController(); const timer = setTimeout(() => search(query, controller.signal), 300); return () => { clearTimeout(timer); controller.abort(); }; }, [query]);
  return <section className="journal-search glass-lite" aria-label="Add journal">
    <div className="panel-heading"><div><span className="eyebrow">DISCOVER JOURNALS</span><h2>Add journal</h2></div><button className="icon-button" aria-label="Close journal search" onClick={close}><Icon name="close" /></button></div>
    <form className="search-field" onSubmit={e => { e.preventDefault(); void search(query); }}><Icon name="search" size={19} /><input autoFocus aria-label="Journal name or ISSN" placeholder="Search journal name, ISSN or EISSN" value={query} onChange={e => setQuery(e.target.value)} maxLength={160} /><kbd>↵</kbd></form>
    <p className="search-caption" role="status">{searching ? 'Fetching journal information…' : '中科院 2025 · IF 2025'}</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className={`search-workspace ${selected ? 'has-selection' : ''}`}>
      <div className="search-results">
        {!searched && !searching && <div className="search-hint"><Icon name="journals" size={26} /><p>Find a journal</p><small></small></div>}
        {searched && !items.length && !searching && <div className="search-hint"><p>No matching journals found</p><small>Enter a complete ISSN to verify it with Crossref.</small>{/^\d{4}-\d{3}[\dX]$/i.test(query.trim()) && <button className="button secondary" disabled={searching} onClick={async () => { setSearching(true); setError(''); try { setSelected(await api<JournalInfo>('journals/verify', { body: { issn: query.trim().toUpperCase() } })); } catch (e) { setError((e as Error).message); } finally { setSearching(false); } }}>Verify with Crossref</button>}</div>}
        {items.map(info => <button key={info.id} className={`search-result ${selected?.id === info.id ? 'selected' : ''}`} onClick={() => setSelected(info)}><span className="journal-monogram">{journalName(info.name).slice(0, 1)}</span><span className="search-result-text"><strong>{journalName(info.name)}</strong><small>{info.issns.join(' / ') || 'ISSN unverified'}</small><JournalTags info={info} /></span><Icon name="chevron" size={15}/></button>)}
      </div>
      {selected && <div className="journal-preview"><span className="eyebrow">Journal details</span><h3>{journalName(selected.name)}</h3><p className="issn">{selected.issns.join(' / ') || 'No ISSN available'}</p><JournalTags info={selected} /><dl className="journal-facts"><div><dt>Category</dt><dd>{selected.category || '暂无中科院分区'}</dd></div><div><dt>中科院大类分区</dt><dd>{selected.zone?.raw || '暂无中科院分区'}</dd></div><div><dt>Top journal</dt><dd>{selected.top === null ? 'Unavailable' : selected.top ? 'Yes' : 'No'}</dd></div><div><dt>IF 2025</dt><dd>{selected.ifDisplay || 'No IF data'}</dd></div></dl>{selected.subjects.length > 0 && <div className="subject-details"><span className="eyebrow">Subject rankings</span>{selected.subjects.map(subject => <p key={subject.name}>{subject.name}<span>{subject.zone.raw}</span></p>)}</div>}<p className="data-note">{selected.ifYear ? 'IF metric year 2025, released in 2026.' : 'No matching impact factor.'}<br />{selected.casYear ? '中科院分区表升级版 2025。' : '暂无匹配的中科院分区。'}<br /><a href={selected.source === 'crossref' ? 'https://api.crossref.org/' : 'https://github.com/hitfyd/ShowJCR/tree/4687a8f608f20aaf004299992f5d347dba009361'} target="_blank" rel="noreferrer">Source: {selected.source === 'crossref' ? 'Crossref' : 'ShowJCR pinned snapshot'} <Icon name="external" size={11} /></a></p><button className="button primary full" disabled={following || followed.has(selected.name)} onClick={async () => { setFollowing(true); setError(''); try { await api('journals', { body: selected.id.startsWith('crossref:') ? { issn: selected.issns[0] } : { catalogId: selected.id } }); await done(journalName(selected.name)); } catch (e) { setError((e as Error).message); } finally { setFollowing(false); } }}><Icon name={followed.has(selected.name) ? 'check' : 'plus'} size={16}/>{following ? 'Saving…' : followed.has(selected.name) ? 'Following' : 'Follow journal'}</button></div>}
    </div>
  </section>;
}
export function JournalTags({ info }: { info: Pick<JournalInfo, 'zone' | 'top' | 'ifDisplay'> }) {
  return <span className="journal-tags"><span className="tag">{info.zone?.zone ? `中科院 ${info.zone.zone} 区` : '暂无中科院分区'}</span>{info.top === true && <span className="tag top-tag">TOP</span>}<span className="tag if-tag">IF {info.ifDisplay || '—'}</span></span>;
}
