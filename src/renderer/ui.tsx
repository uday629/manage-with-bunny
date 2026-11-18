import { useEffect, useRef, useState, type ReactNode, type ButtonHTMLAttributes } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore, type User, setState , exportTable, type ExportTable } from './api';

const P: Record<string, string> = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z',
  tasks: 'M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9',
  team: 'M12 3v4M5 14v-3h14v3M12 7a2 2 0 1 0 0 .01M3 17h4v4H3zM10 17h4v4h-4zM17 17h4v4h-4zM12 11v6',
  files: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  records: 'M3 5h18v14H3zM3 10h18M3 15h18M9 5v14',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  shield: 'M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  plus: 'M12 5v14M5 12h14', search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.3-4.3', send: 'M22 2 11 13M22 2l-7 20-4-9-9-4z',
  clip: 'M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5', x: 'M18 6 6 18M6 6l12 12', check: 'M20 6 9 17l-5-5',
  left: 'M15 18l-6-6 6-6', up: 'M18 15l-6-6-6 6', right: 'M9 18l6-6-6-6', down: 'M6 9l6 6 6-6', download: 'M12 3v12M7 10l5 5 5-5M5 21h14', trash: 'M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z', reply: 'M9 17l-5-5 5-5M4 12h11a5 5 0 0 1 5 5v2', more: 'M12 6h.01M12 12h.01M12 18h.01',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4', wifi: 'M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a15 15 0 0 1 20 0M12 20h.01',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7', play: 'M6 4l14 8-14 8z',
  image: 'M3 5h18v14H3zM8.5 10a1.5 1.5 0 1 0 0-.01M21 15l-5-5L5 19', video: 'M3 6h12v12H3zM15 10l6-3v10l-6-3', file: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1', refresh: 'M21 12a9 9 0 0 1-15.5 6.3L3 16M3 12a9 9 0 0 1 15.5-6.3L21 8M21 3v5h-5M3 21v-5h5', logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  user: 'M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z', users: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0', star: 'M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  flag: 'M4 22V4M4 4h13l-2 4 2 4H4', upload: 'M12 21V9M7 14l5-5 5 5M5 3h14', server: 'M3 4h18v6H3zM3 14h18v6H3zM7 7h.01M7 17h.01', globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20',
  insta: 'M7 2h10a5 5 0 0 1 5 5v10a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5V7a5 5 0 0 1 5-5zM16 11.4A4 4 0 1 1 12.6 8 4 4 0 0 1 16 11.4zM17.5 6.5h.01',
  layers: 'M12 2 2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5', key: 'M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4',
  sun: 'M12 3v2M12 19v2M5 12H3M21 12h-2', mic: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3', pause: 'M7 4h3v16H7zM14 4h3v16h-3z', excel: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13l4 5M12 13l-4 5', pdf: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 15h8M8 18h5', grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01', activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
};
export function Icon({ name, size = 18, className = '' }: { name: string; size?: number; className?: string }) {
  return (
    <svg className={'ic ' + className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={P[name] || P.file} />
    </svg>
  );
}

export function Logo({ size = 32 }: { size?: number }) { return <img src="logo.png" width={size} height={size} alt="" className="logo-img" draggable={false} />; }

export function Avatar({ user, size = 32, ring = false }: { user?: User | null; size?: number; ring?: boolean }) {
  const name = user?.displayName || '?';
  const initials = name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  return (
    <span className={'avatar' + (ring ? ' ring' : '')} style={{ width: size, height: size, fontSize: size * 0.38, background: user?.color || '#333' }} title={name}>
      {initials}
      {user && !user.isRemote && <i className={'dot ' + (user.online ? 'on' : 'off')} style={{ width: Math.max(8, size * 0.28), height: Math.max(8, size * 0.28) }} />}
    </span>
  );
}

export function Btn({ kind = 'ghost', icon, children, loading, small, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: 'primary' | 'ghost' | 'danger' | 'soft'; icon?: string; loading?: boolean; small?: boolean }) {
  return (
    <button type="button" {...rest} disabled={rest.disabled || loading} className={`btn btn-${kind}${small ? ' btn-sm' : ''} ${rest.className || ''}`}>
      {loading ? <Spinner size={14} /> : icon ? <Icon name={icon} size={small ? 14 : 16} /> : null}
      {children && <span>{children}</span>}
    </button>
  );
}

export function Spinner({ size = 18 }: { size?: number }) { return <span className="spinner" style={{ width: size, height: size }} role="status" aria-label="Loading" />; }

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {error ? <span className="field-err" role="alert">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function Modal({ title, onClose, children, wide, footer }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    ref.current?.querySelector<HTMLElement>('input,textarea,select,button.btn-primary')?.focus();
    return () => window.removeEventListener('keydown', k);
  }, []);
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={'modal' + (wide ? ' wide' : '')} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="modal-head"><h3>{title}</h3><button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// Promise-based confirm dialog rendered into its own root.
export function confirmDialog(o: { title: string; text: ReactNode; ok?: string; danger?: boolean; input?: string }): Promise<string | boolean> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (v: string | boolean) => { root.unmount(); host.remove(); resolve(v); };
    function C() {
      const [val, setVal] = useState('');
      return (
        <Modal title={o.title} onClose={() => done(false)} footer={<>
          <Btn onClick={() => done(false)}>Cancel</Btn>
          <Btn kind={o.danger ? 'danger' : 'primary'} disabled={!!o.input && val !== o.input} onClick={() => done(o.input ? val : true)}>{o.ok || 'Confirm'}</Btn>
        </>}>
          <div className="confirm-text">{o.text}</div>
          {o.input && <Field label={`Type "${o.input}" to confirm`}><input value={val} onChange={(e) => setVal(e.target.value)} /></Field>}
        </Modal>
      );
    }
    root.render(<C />);
  });
}

export function Empty({ icon = 'layers', title, text, action }: { icon?: string; title: string; text?: ReactNode; action?: ReactNode }) {
  return <div className="empty"><div className="empty-ic"><Icon name={icon} size={26} /></div><h4>{title}</h4>{text && <p>{text}</p>}{action}</div>;
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={'toast toast-' + t.kind} onClick={() => setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) }))}>
          <Icon name={t.kind === 'err' ? 'x' : t.kind === 'ok' ? 'check' : 'bell'} size={16} /> <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { id: T; label: string; badge?: number; hidden?: boolean }[] }) {
  return (
    <div className="tabs" role="tablist">
      {items.filter((i) => !i.hidden).map((i) => (
        <button key={i.id} role="tab" aria-selected={value === i.id} className={'tab' + (value === i.id ? ' on' : '')} onClick={() => onChange(i.id)}>
          {i.label}{i.badge ? <b className="badge">{i.badge}</b> : null}
        </button>
      ))}
    </div>
  );
}

export function Progress({ value, tone }: { value: number; tone?: string }) {
  return <div className="progress"><i style={{ width: `${Math.max(0, Math.min(100, value))}%`, background: tone }} /></div>;
}

export function UserPicker({ users, selected, onChange, multi = true, placeholder = 'Search people' }: { users: User[]; selected: string[]; onChange: (ids: string[]) => void; multi?: boolean; placeholder?: string }) {
  const [q, setQ] = useState('');
  const list = users.filter((u) => !q || u.displayName.toLowerCase().includes(q.toLowerCase()) || u.username.includes(q.toLowerCase())).slice(0, 200);
  return (
    <div className="picker">
      <div className="search-box"><Icon name="search" size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} /></div>
      <div className="picker-list">
        {list.map((u) => {
          const on = selected.includes(u.id);
          return (
            <button key={u.id} className={'picker-row' + (on ? ' on' : '')} onClick={() => onChange(multi ? (on ? selected.filter((x) => x !== u.id) : [...selected, u.id]) : [u.id])}>
              <Avatar user={u} size={28} /><span className="grow"><b>{u.displayName}</b><small>{u.title || '@' + u.username}</small></span>
              <span className={'check' + (on ? ' on' : '')}>{on && <Icon name="check" size={14} />}</span>
            </button>
          );
        })}
        {!list.length && <p className="muted pad">No one matches.</p>}
      </div>
    </div>
  );
}

export function Stars({ value, onChange, size = 16 }: { value: number; onChange?: (n: number) => void; size?: number }) {
  return (
    <span className="stars" role={onChange ? 'radiogroup' : undefined} aria-label={`${value} of 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" disabled={!onChange} className={n <= value ? 'on' : ''} onClick={() => onChange?.(n)} aria-label={`${n} star`}><Icon name="star" size={size} /></button>
      ))}
    </span>
  );
}

export function ExportButtons({ table, disabled }: { table: () => ExportTable; disabled?: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (f: 'xlsx' | 'pdf') => { setBusy(f); try { await exportTable(f, table()); } finally { setBusy(null); } };
  return (
    <span className="row" style={{ gap: 6 }}>
      <Btn small icon="excel" loading={busy === 'xlsx'} disabled={disabled} onClick={() => run('xlsx')} title="Export to Excel">Excel</Btn>
      <Btn small icon="pdf" loading={busy === 'pdf'} disabled={disabled} onClick={() => run('pdf')} title="Export to PDF">PDF</Btn>
    </span>
  );
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fn().then((d) => { if (alive) { setData(d); setError(null); } }).catch((e) => { if (alive) setError(e.message); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [...deps, n]);
  return { data, error, loading, reload: () => setN((x) => x + 1) };
}

export function ErrorBox({ text, retry }: { text: string; retry?: () => void }) {
  return <div className="error-box" role="alert"><Icon name="x" size={16} /><span>{text}</span>{retry && <Btn small onClick={retry} icon="refresh">Retry</Btn>}</div>;
}

// Renders plain text with safe clickable links (React escapes everything; links open in the OS browser via main).
export function RichText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>"']{2,2000})/g);
  return <>{parts.map((p, i) => (i % 2 ? <a key={i} href="#" onClick={(e) => { e.preventDefault(); (window as any).bunny.openExternal(p); }} title={p}>{p}</a> : <span key={i}>{p}</span>))}</>;
}
