'use client';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icon';

export type Notice = { id: string; message: string; tone?: 'success' | 'error'; duration?: number; action?: { label: string; expiresAt?: number; run: () => Promise<void> } };
export function Toasts({ notices, remove }: { notices: Notice[]; remove: (id: string) => void }) {
  const [small, setSmall] = useState(false), [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); const query = matchMedia('(max-width: 760px)'); const update = () => setSmall(query.matches); update(); query.addEventListener('change', update); return () => query.removeEventListener('change', update); }, []);
  if (!mounted) return null;
  return createPortal(<div className="notification-slot" aria-label="Notifications"><div className="notification-stack">{notices.slice(0, small ? 1 : 2).map(n => <Toast key={n.id} notice={n} remove={remove} />)}</div></div>, document.body);
}
function Toast({ notice, remove }: { notice: Notice; remove: (id: string) => void }) {
  const node = useRef<HTMLDivElement>(null), [fading, setFading] = useState(false), [busy, setBusy] = useState(false), [actionError, setActionError] = useState('');
  const remaining = useRef(Math.max(3000, notice.duration ?? (notice.action ? 8000 : 3000)));
  const fadeAnimation = useRef<Animation | null>(null);
  const [hover, setHover] = useState(false), [focus, setFocus] = useState(false);
  const [hidden, setHidden] = useState(false);
  useEffect(() => { const update = () => setHidden(document.hidden); update(); document.addEventListener('visibilitychange', update); return () => document.removeEventListener('visibilitychange', update); }, []);
  useEffect(() => {
    if (hover || focus || hidden || busy || notice.tone === 'error' || fading) return;
    // Allow 150ms entry to finish before counting fully visible reading time.
    let start = 0;
    const entry = setTimeout(() => { start = performance.now(); }, 150);
    const timer = setTimeout(() => setFading(true), remaining.current + 150);
    return () => { clearTimeout(entry); clearTimeout(timer); if (start) remaining.current = Math.max(0, remaining.current - (performance.now() - start)); };
  }, [hover, focus, hidden, busy, notice.tone, fading]);
  useEffect(() => {
    if (!fading || !node.current) return;
    const animation = node.current.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 3000, easing: 'linear', fill: 'forwards' });
    fadeAnimation.current = animation;
    animation.onfinish = () => remove(notice.id);
    return () => { animation.cancel(); fadeAnimation.current = null; };
  }, [fading, notice.id, remove]);
  useEffect(() => {
    const animation = fadeAnimation.current;
    if (!animation) return;
    if (hover || focus || hidden || busy) animation.pause(); else animation.play();
  }, [hover, focus, hidden, busy, fading]);
  return <div ref={node} className={`toast liquid-glass-menu ${fading ? 'toast-leaving' : ''} ${notice.tone === 'error' ? 'toast-error' : ''}`} role="status" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onFocusCapture={() => setFocus(true)} onBlurCapture={e => { if (!e.currentTarget.contains(e.relatedTarget)) setFocus(false); }}>
    <span className="toast-icon"><Icon name={notice.tone === 'error' ? 'close' : 'check'} size={16} /></span>
    <div className="toast-content"><p>{notice.message}</p>{notice.action && <button className="text-button" disabled={busy} onClick={async () => {
      if (notice.action!.expiresAt && notice.action!.expiresAt < Date.now()) { setActionError('Undo period expired'); return; }
      setBusy(true); try { await notice.action!.run(); remove(notice.id); } catch (e) { setActionError(e instanceof Error ? e.message : 'Operation failed'); } finally { setBusy(false); }
    }}>{busy ? 'Processing…' : notice.action.label}</button>}{actionError && <small>{actionError}</small>}</div>
    <button className="icon-button toast-close" aria-label="Dismiss notification" onClick={() => remove(notice.id)}><Icon name="close" size={14} /></button>
  </div>;
}
