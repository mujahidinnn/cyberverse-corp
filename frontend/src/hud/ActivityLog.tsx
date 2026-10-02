import { useEffect, useRef, useState } from 'react';
import { useOffice, type ServerEvent } from '../store/officeStore';
import { api } from '../net/api';
import type { FeedKind } from '../store/feed';
import { Icon, Loading } from './icons';
import { Portrait } from './Portrait';

const FILTERS: [FeedKind | 'all', string][] = [
  ['all', 'Semua'], ['task', 'Task'], ['talk', 'Obrolan'], ['tool', 'Tool'], ['approval', 'Izin'], ['alert', 'Alert'],
];
const KEY = 'cyberverse_log_open';

function readOpen(): boolean {
  try {
    return localStorage.getItem(KEY) !== '0';
  } catch {
    return true;
  }
}

const time = (ms: number) => {
  const d = new Date(ms);
  const clock = d.toLocaleTimeString('id-ID', { hour12: false });
  return d.toDateString() === new Date().toDateString() ? clock : `${d.toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit' })} ${clock}`;
};

export function ActivityLog() {
  const feed = useOffice((s) => s.feed);
  const clearFeed = useOffice((s) => s.clearFeed);
  const clear = async () => {
    if (!window.confirm('Hapus semua riwayat Log Live? Riwayat tidak akan muncul lagi setelah halaman dimuat ulang.')) return;
    try {
      await api('/events', { method: 'DELETE' });
      clearFeed();
    } catch (e) {
      window.alert(`Gagal menghapus: ${(e as Error).message}`);
    }
  };
  const select = useOffice((s) => s.select);
  const agents = useOffice((s) => s.agents);
  const ready = useOffice((s) => s.connected && Object.keys(s.agents).length > 0);
  const [open, setOpen] = useState(readOpen);

  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!ready) return;
    setLoading(true);
    api<ServerEvent[]>('/events?limit=300').then(useOffice.getState().loadHistory).catch(console.warn).finally(() => setLoading(false));
  }, [ready]);
  const [filter, setFilter] = useState<FeedKind | 'all'>('all');
  const list = useRef<HTMLOListElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, open ? '1' : '0');
    } catch {
    }
    document.documentElement.style.setProperty('--log-w', open ? '336px' : '0px');
  }, [open]);

  const rows = filter === 'all' ? feed : feed.filter((f) => f.kind === filter || (filter === 'task' && f.kind === 'goal'));

  useEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [rows.length, open]);

  if (!open) {
    return (
      <button className="log-tab" onClick={() => setOpen(true)} aria-label="Buka log live">
        <Icon name="live" /> Log{feed.length > 0 && <b>{feed.length}</b>}
      </button>
    );
  }

  return (
    <aside className="log-panel" aria-label="Log live aktivitas kantor">
      <header>
        <span className="live-dot" aria-hidden /> <b>Log Live</b> <span className="muted">{feed.length} kejadian</span>
        <span className="spacer" />
        <button className="ghost small" onClick={clear} disabled={!feed.length}>Hapus riwayat</button>
        <button className="ghost small" onClick={() => setOpen(false)} aria-label="Lipat log"><Icon name="collapse" size={14} /></button>
      </header>
      <div className="log-filters" role="tablist">
        {FILTERS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={filter === k} className={filter === k ? 'small' : 'ghost small'} onClick={() => setFilter(k)}>
            {label}
          </button>
        ))}
      </div>
      <ol
        ref={list}
        aria-live="off"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {rows.length === 0 && loading && <li className="empty"><Loading>Memuat riwayat</Loading></li>}
        {rows.length === 0 && !loading && <li className="muted empty">Belum ada aktivitas. Kirim goal lewat Papan kerja (Tab) untuk memulai.</li>}
        {rows.map((f) => (
          <li key={f.id} className={`log-row ${f.tone ?? ''}`}>
            {f.agent_id && agents[f.agent_id] ? <Portrait agentId={f.agent_id} size={30} /> : <span className="portrait system" aria-hidden><Icon name={f.icon} size={14} /></span>}
            <div className="log-main">
              <div className="log-head">
                {f.agent_id && agents[f.agent_id] ? (
                  <button className="log-who" onClick={() => select(f.agent_id!)} title="Sorot agen ini">
                    <b>{agents[f.agent_id].name}</b> <span className="muted">{agents[f.agent_id].role}</span>
                  </button>
                ) : (
                  <b>Sistem</b>
                )}
                <time>{time(f.at)}</time>
              </div>
              <div className="log-text">
                {f.agent_id && agents[f.agent_id] && <Icon name={f.icon} size={13} className={`tone-${f.tone ?? 'none'}`} />} {f.text}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </aside>
  );
}
