import { useState } from 'react';
import { useOffice } from '../store/officeStore';
import { send } from '../net/wsClient';
import { api } from '../net/api';
import { Markdown } from './Markdown';
import { Icon, Loading } from './icons';

const shortModel = (m: string) => m.split('/').slice(1).join('/').replace(':free', ' (free)');

export function QuotaChip() {
  const quota = useOffice((s) => s.quota);
  const health = useOffice((s) => s.health);
  const [open, setOpen] = useState(false);
  const known = quota.filter((q) => q.rpd_pct_left !== null);
  const min = known.length ? Math.min(...known.map((q) => q.rpd_pct_left!)) : null;
  const level = min === null ? '' : min < 5 ? 'crit' : min < 20 ? 'warn' : 'ok';

  return (
    <div className="quota">
      <button className={`ghost quota-chip ${level}`} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Icon name="quota" /> Kuota {min === null ? '-' : `${min}%`}
      </button>
      {open && (
        <div className="quota-panel" role="dialog" aria-label="Kuota LLM dan kesehatan sistem">
          <h4>Kuota harian LLM (Masa)</h4>
          {quota.length === 0 && <Loading>Memuat kuota</Loading>}
          {quota.map((q) => {
            const pct = q.rpd_pct_left;
            const cooling = q.cooldown_until && q.cooldown_until * 1000 > Date.now();
            return (
              <div key={q.model} className="quota-row">
                <span className="quota-name" title={q.model}>{shortModel(q.model)}</span>
                <span className="bar" aria-hidden>
                  <span style={{ width: `${pct ?? 100}%` }} className={pct !== null && pct < 20 ? 'low' : ''} />
                </span>
                <span className="quota-val">
                  {pct === null ? '∞' : `${pct}%`} {q.in_flight > 0 && <Icon name="busy" size={12} />} {cooling && <Icon name="cooldown" size={12} />}
                </span>
              </div>
            );
          })}
          <p className="muted"><Icon name="busy" size={12} /> sedang dipakai · <Icon name="cooldown" size={12} /> cooldown setelah rate limit</p>
          {health && (
            <>
              <h4>Kesehatan server (Seiji)</h4>
              <p className="health">
                CPU {health.cpu_pct}% · RAM {health.ram_pct}% · Disk {health.disk_pct}% · {health.ws_clients} klien
                {health.ollama_up !== undefined && ` · Ollama ${health.ollama_up ? 'aktif' : 'mati'}`}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function Toasts() {
  const alerts = useOffice((s) => s.alerts);
  const agents = useOffice((s) => s.agents);
  const dismiss = useOffice((s) => s.dismissAlert);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {alerts.map((a) => (
        <div key={a.id} className={`toast toast-${a.level}`}>
          <b><Icon name={a.level === 'CRITICAL' ? 'critical' : a.level === 'WARN' ? 'alert' : 'info'} size={14} /> {a.code}</b>
          <span>
            {a.agent_id && agents[a.agent_id] ? `${agents[a.agent_id].name} (${agents[a.agent_id].role}): ` : ''}
            {a.message}
          </span>
          <button className="link" onClick={() => dismiss(a.id)} aria-label="Tutup notifikasi"><Icon name="close" size={14} /></button>
        </div>
      ))}
    </div>
  );
}

export function MeetingControls() {
  const meeting = useOffice((s) => s.meeting);
  const [showMinutes, setShowMinutes] = useState(true);
  const start = () => {
    if (window.confirm('Panggil All-Hands Meeting? Agen yang idle akan berkumpul di Town Hall.')) {
      send('USER_START_MEETING', { type: 'ALL_HANDS' });
      setShowMinutes(true);
    }
  };
  return (
    <>
      <button className="ghost" onClick={start} disabled={!!meeting?.running} title="All-Hands (tombol M)" aria-label="All-Hands">
        <Icon name="meeting" /> <span className="max-xl:hidden">All-Hands</span>
      </button>
      {meeting?.running && <div className="meeting-banner" role="status"><Icon name="loading" className="spin" /> All-Hands Meeting sedang berlangsung di Town Hall</div>}
      {meeting && !meeting.running && meeting.minutes && showMinutes && (
        <div className="modal-backdrop" onClick={() => setShowMinutes(false)}>
          <div className="modal minutes" role="dialog" aria-label="Notulen rapat" onClick={(e) => e.stopPropagation()}>
            <h2><Icon name="minutes" size={18} /> Notulen All-Hands (Nana)</h2>
            <div className="doc-scroll"><Markdown text={meeting.minutes} /></div>
            <div className="modal-actions">
              <button className="ghost" onClick={async () => {
                if (!window.confirm('Hapus notulen rapat ini? Agen juga tidak akan mengingatnya lagi.')) return;
                try {
                  await api(`/meetings/${meeting.meeting_id}`, { method: 'DELETE' });
                } catch (e) {
                  window.alert(`Gagal menghapus: ${(e as Error).message}`);
                }
              }}><Icon name="trash" size={14} /> Hapus notulen</button>
              <button onClick={() => setShowMinutes(false)}>Tutup</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
