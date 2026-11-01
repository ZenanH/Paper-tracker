'use client';
import { useEffect, useRef, useState } from 'react';
import { api, APIError } from './client-api';
import type { Notice } from './toasts';

type SettingsData = { baseURL: string; model: string; hasKey: boolean; filterPrompt: string; configVersion: number; installedAt: number; deploymentMonthStart: number; hour: number; minute: number };
type Direction = 'local_to_cloud' | 'cloud_to_local';
type WebDAVData = { baseURL: string; remotePath: string; username: string; hasPassword: boolean; configured: boolean; initialized: boolean; direction: Direction; status: string; lastAttemptAt: number | null; lastSuccessAt: number | null; lastError: string | null };

const statusLabels: Record<string, string> = { not_configured: 'Not configured', setup_required: 'Setup required', pending: 'Backup pending', retrying: 'Retrying backup', failed: 'Backup failed', synced: 'Up to date', idle: 'Ready' };

export function Settings({ notify, changed, confirm }: { notify: (n: Omit<Notice, 'id'>) => void; changed: () => void; confirm: (message: string, action: () => Promise<void>) => void }) {
  const [data, setData] = useState<SettingsData | null>(null), [key, setKey] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [testing, setTesting] = useState(false);
  const [email, setEmail] = useState(''), [emailBusy, setEmailBusy] = useState(false);
  const [webdav, setWebdav] = useState<WebDAVData | null>(null), [webdavURL, setWebdavURL] = useState(''), [webdavPath, setWebdavPath] = useState('paper-tracker/config.json');
  const [webdavUser, setWebdavUser] = useState(''), [webdavPassword, setWebdavPassword] = useState(''), [anonymous, setAnonymous] = useState(false);
  const [direction, setDirection] = useState<Direction>('local_to_cloud'), [webdavBusy, setWebdavBusy] = useState(false), [webdavError, setWebdavError] = useState('');
  const lastFailure = useRef('');

  useEffect(() => { api<{ email: string }>('settings/crossref').then(r => setEmail(r.email)).catch(e => notify({ message: e.message, tone: 'error' })); }, [notify]);
  useEffect(() => { api<SettingsData>('settings').then(setData).catch(e => setError(e.message)); }, []);
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setInterval>;
    async function load(initial = false) {
      try {
        const result = await api<WebDAVData>('settings/webdav', { uncached: true });
        if (!active) return;
        if (initial) {
          setWebdav(result); setWebdavURL(result.baseURL); setWebdavPath(result.remotePath || 'paper-tracker/config.json');
          setWebdavUser(result.username); setAnonymous(!result.username && !result.hasPassword); setDirection(result.direction);
        } else setWebdav(old => old ? { ...old, initialized: result.initialized, status: result.status, lastAttemptAt: result.lastAttemptAt, lastSuccessAt: result.lastSuccessAt, lastError: result.lastError } : result);
        const failureId = (result.status === 'failed' || result.status === 'retrying') ? result.lastError || '' : '';
        if (!initial && failureId && lastFailure.current !== failureId) {
          lastFailure.current = failureId;
          notify({ message: `WebDAV backup ${result.status === 'retrying' ? 'failed; automatic retry is pending' : 'failed'}: ${result.lastError}`, tone: 'error' });
        }
        if (initial) lastFailure.current = failureId;
        else if (!failureId) lastFailure.current = '';
      } catch (e) { if (initial && active) setWebdavError((e as Error).message); }
    }
    void load(true); timer = setInterval(() => { void load(); }, 8000);
    return () => { active = false; clearInterval(timer); };
  }, [notify]);

  async function saveAI(confirmed = false) {
    if (!data) return; setBusy(true); setError('');
    try {
      const result = await api<SettingsData>('settings', { body: { baseURL: data.baseURL, model: data.model, apiKey: key, filterPrompt: data.filterPrompt, confirmReprocess: confirmed } });
      setData(result); setKey(''); notify({ message: 'AI settings saved. The worker will use the new configuration.' }); changed();
    } catch (e) { if (e instanceof APIError && e.code === 'reprocess_confirmation_required') confirm(e.message, () => saveAI(true)); else setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function syncWebDAV() {
    setWebdavBusy(true); setWebdavError('');
    try {
      const result = await api<WebDAVData>('settings/webdav', { body: { action: 'sync', baseURL: webdavURL, remotePath: webdavPath, username: anonymous ? '' : webdavUser, password: anonymous ? '' : webdavPassword, clearCredentials: anonymous, direction } });
      setWebdav(result); setWebdavURL(result.baseURL); setWebdavPath(result.remotePath); setWebdavUser(result.username); setWebdavPassword(''); setAnonymous(!result.username && !result.hasPassword);
      notify({ message: direction === 'local_to_cloud' ? 'Local configuration uploaded to WebDAV.' : 'Cloud configuration applied locally.' }); changed();
    } catch (e) {
      setWebdavError((e as Error).message);
      try { const state = await api<WebDAVData>('settings/webdav', { uncached: true }); setWebdav(old => old ? { ...old, initialized: state.initialized, status: state.status, lastAttemptAt: state.lastAttemptAt, lastSuccessAt: state.lastSuccessAt, lastError: state.lastError } : state); } catch { /* Keep the operation error visible. */ }
    } finally { setWebdavBusy(false); }
  }

  async function retryWebDAV() {
    setWebdavBusy(true); setWebdavError('');
    try { const result = await api<WebDAVData>('settings/webdav', { body: { action: 'retry' } }); setWebdav(result); notify({ message: 'WebDAV backup retry queued.' }); }
    catch (e) { setWebdavError((e as Error).message); }
    finally { setWebdavBusy(false); }
  }

  if (!data) return <p className="muted">{error || 'Loading settings…'}</p>;
  return <div className="settings-stack">
    <section className="settings-section glass-lite"><h2>AI connection</h2><p className="section-description">Title filtering and translation.</p><form onSubmit={e => { e.preventDefault(); void saveAI(); }}>
      <label className="field">API base URL <input value={data.baseURL} onChange={e => setData({ ...data, baseURL: e.target.value })} placeholder="https://api.openai.com/v1" type="url" maxLength={1000}/><small>OpenAI-compatible base URL.</small></label>
      <div className="field-row"><label className="field">API Key <input type="password" autoComplete="new-password" value={key} onChange={e => setKey(e.target.value)} placeholder={data.hasKey ? 'Saved securely · Leave blank to keep' : 'Enter your own API key'} maxLength={4096}/></label><label className="field">Model <input value={data.model} onChange={e => setData({ ...data, model: e.target.value })} placeholder="Enter a model supported by your provider" maxLength={200}/></label></div>
      <label className="field">Filter prompt <textarea value={data.filterPrompt} onChange={e => setData({ ...data, filterPrompt: e.target.value })} rows={5} maxLength={6000}/><small>Enable filtering per journal.</small></label>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="form-actions"><button className="button primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button><button type="button" className="button secondary" disabled={testing || !data.hasKey} onClick={async () => { setTesting(true); setError(''); try { await api('settings/test', { body: {} }); notify({ message: 'Connection successful. The selected model is available.' }); } catch (e) { setError((e as Error).message); } finally { setTesting(false); } }}>{testing ? 'Testing…' : 'Test connection'}</button>{data.hasKey && <button type="button" className="button secondary danger" onClick={() => confirm('Delete the saved AI key? New AI tasks will pause. Existing results are retained.', async () => { const result = await api<SettingsData>('settings', { body: { ...data, deleteKey: true, confirmReprocess: true } }); setData(result); setKey(''); changed(); notify({ message: 'AI key deleted. Existing results retained.' }); })}>Delete saved key</button>}</div><p className="data-note">Connection tests use API credit.</p>
    </form></section>

    <section className="settings-section glass-lite"><h2>Crossref</h2><form onSubmit={async e => { e.preventDefault(); setEmailBusy(true); try { const result = await api<{ email: string }>('settings/crossref', { body: { email: email.trim() } }); setEmail(result.email); notify({ message: 'Crossref email saved.' }); } catch (e) { notify({ message: (e as Error).message, tone: 'error' }); } finally { setEmailBusy(false); } }}><label className="field">Email <input type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} maxLength={254} placeholder="you@example.com"/><small>Optional · Sent only to Crossref.</small></label><button className="button secondary" disabled={emailBusy}>{emailBusy ? 'Saving…' : 'Save'}</button></form></section>

    <section className="settings-section glass-lite"><h2>Automatic sync</h2><p className="section-description">Daily · Beijing time (UTC+8)</p><form onSubmit={async e => { e.preventDefault(); try { await api('settings/schedule', { body: { hour: data.hour, minute: data.minute } }); notify({ message: 'Sync schedule updated.' }); changed(); } catch (e) { notify({ message: (e as Error).message, tone: 'error' }); } }}><div className="schedule-row"><label className="field">Daily <input aria-label="Daily sync time (Beijing)" type="time" value={`${String(data.hour).padStart(2, '0')}:${String(data.minute).padStart(2, '0')}`} onChange={e => { const [hour, minute] = e.target.value.split(':').map(Number); setData({ ...data, hour, minute }); }}/></label><button className="button secondary">Save</button></div></form><div className="installation-note"><span>Initialized</span><strong>{new Date(data.installedAt).toLocaleString('en-US', { timeZone: 'Asia/Shanghai', hour12: false })}</strong><span>Earliest fetch date</span><strong>{new Date(data.deploymentMonthStart).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })}</strong></div></section>

    <section className="settings-section glass-lite"><h2>WebDAV configuration sync</h2><p className="section-description">Encrypted configuration backup · Restore requires the same instance encryption key.</p>
      <form onSubmit={e => { e.preventDefault(); if (direction === 'cloud_to_local' && webdav?.configured) confirm('Cloud configuration will replace local follows and settings. Existing papers, favorites, and archives will remain.', syncWebDAV); else void syncWebDAV(); }}>
        <label className="field">WebDAV server URL <input type="url" value={webdavURL} onChange={e => setWebdavURL(e.target.value)} placeholder="https://dav.example.com/dav/" maxLength={2000}/></label>
        <label className="field">Remote file path <input value={webdavPath} onChange={e => setWebdavPath(e.target.value)} placeholder="paper-tracker/config.json" maxLength={1024}/><small>Relative to the WebDAV server URL.</small></label>
        <div className="field-row"><label className="field">Username <input value={webdavUser} onChange={e => setWebdavUser(e.target.value)} autoComplete="username" disabled={anonymous} maxLength={256}/></label><label className="field">Password <input type="password" value={webdavPassword} onChange={e => setWebdavPassword(e.target.value)} autoComplete="new-password" placeholder={webdav?.hasPassword ? 'Saved securely · Leave blank to keep' : 'WebDAV password'} disabled={anonymous} maxLength={4096}/></label></div>
        <label className="check-field"><input type="checkbox" checked={anonymous} onChange={e => setAnonymous(e.target.checked)}/> Use anonymous access</label>
        <label className="field">Sync direction <select value={direction} onChange={e => setDirection(e.target.value as Direction)}><option value="local_to_cloud">Local configuration overwrites cloud</option><option value="cloud_to_local">Cloud configuration overwrites local</option></select></label>
        {webdavError && <p className="inline-error" role="alert">{webdavError}</p>}
        <div className="form-actions"><button className="button primary" disabled={webdavBusy || !webdavURL.trim()}>{webdavBusy ? 'Synchronizing…' : webdav?.configured ? 'Save connection & sync' : 'Connect & sync'}</button>{webdav?.status === 'failed' && webdav.initialized && <button type="button" className="button secondary" disabled={webdavBusy} onClick={() => void retryWebDAV()}>{webdavBusy ? 'Queuing…' : 'Retry backup'}</button>}</div>
      </form>
      <div className={`webdav-status ${webdav?.status === 'failed' ? 'is-error' : ''}`} role={webdav?.status === 'failed' ? 'alert' : 'status'}><strong>{statusLabels[webdav?.status || 'not_configured'] || 'WebDAV status unavailable'}</strong>{webdav?.lastError && <span>{webdav.lastError}</span>}{webdav?.lastSuccessAt && <small>Last successful backup: {new Date(webdav.lastSuccessAt).toLocaleString('en-US', { timeZone: 'Asia/Shanghai', hour12: false })}</small>}</div>
      <p className="data-note">Followed journals, per-journal filtering, AI connection settings, Crossref email, and the daily sync time are included. The WebDAV password stays local.</p>
    </section>
  </div>;
}
