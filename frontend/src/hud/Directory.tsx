import { useMemo, useState } from 'react';
import { useOffice, type AgentState } from '../store/officeStore';
import { api } from '../net/api';
import { DIVISION_COLOR } from '../scene/visuals';
import { Icon, type IconKey } from './icons';
import { Portrait } from './Portrait';

const DIVISIONS: [string, IconKey, string][] = [
  ['executive', 'executive', 'Executive & Strategy'],
  ['engineering', 'engineering', 'Engineering & Tech'],
  ['creative', 'creative', 'Creative & Content'],
  ['marketing', 'marketing', 'Marketing & Growth'],
  ['operations', 'operations', 'Operations, HR & Support'],
];

const STATUS_DOT: Record<string, string> = {
  IDLE: '#94a3b8', THINKING: '#f59e0b', WORKING: '#22c55e', QUEUED: '#64748b', WAITING_APPROVAL: '#ef4444',
  TALKING: '#3b82f6', MEETING: '#0ea5e9', ERROR: '#b91c1c', OFFLINE: '#334155',
};

function focus(agentId: string, close: () => void) {
  useOffice.getState().select(agentId);
  close();
}

function Person({ a, close, compact }: { a: AgentState; close: () => void; compact?: boolean }) {
  return (
    <button className={`org-card ${compact ? 'compact' : ''}`} onClick={() => focus(a.agent_id, close)}
      style={{ borderColor: DIVISION_COLOR[a.division] }} title={a.job}>
      <span className="dot" style={{ background: STATUS_DOT[a.status] }} aria-label={a.status} />
      <Portrait agentId={a.agent_id} size={compact ? 22 : 34} />
      <b>{a.name}</b>
      <small>{a.role}</small>
    </button>
  );
}

function OrgChart({ agents, close }: { agents: AgentState[]; close: () => void }) {
  const byId = Object.fromEntries(agents.map((a) => [a.agent_id, a]));
  const children = (id: string) => agents.filter((a) => a.reports_to === id).sort((x, y) => x.number - y.number);
  const isLead = (id: string) => children(id).length > 0;

  const Node = ({ id }: { id: string }) => {
    const a = byId[id];
    const kids = children(id);
    const leads = kids.filter((k) => isLead(k.agent_id));
    const members = kids.filter((k) => !isLead(k.agent_id));
    return (
      <li>
        <Person a={a} close={close} />
        {kids.length > 0 && (
          <ul>
            {leads.map((k) => <Node key={k.agent_id} id={k.agent_id} />)}
            {members.length > 0 && (
              <li className="members">
                <div className="member-stack">
                  {members.map((m) => <Person key={m.agent_id} a={m} close={close} compact />)}
                </div>
              </li>
            )}
          </ul>
        )}
      </li>
    );
  };

  const root = agents.find((a) => !a.reports_to);
  if (!root) return <p className="muted">Data hierarki belum tersedia.</p>;
  return (
    <div className="org">
      <ul>
        <li>
          <div className="org-card boss"><Icon name="boss" size={18} /> <b>Kamu</b><small>Bos / Supervisor</small></div>
          <ul>
            <Node id={root.agent_id} />
          </ul>
        </li>
      </ul>
    </div>
  );
}

function chatWith(agentId: string, close: () => void) {
  useOffice.getState().openChat(agentId);
  close();
}

function AgentDetail({ a, all, back, close }: { a: AgentState; all: AgentState[]; back: () => void; close: () => void }) {
  const boss = all.find((x) => x.agent_id === a.reports_to);
  const team = all.filter((x) => x.reports_to === a.agent_id);
  const fire = async () => {
    if (!window.confirm(`Berhentikan ${a.name} (${a.role})? Mejanya dikosongkan dan ia tidak menerima task lagi.`)) return;
    try {
      await api(`/agents/${a.agent_id}`, { method: 'DELETE' });
      back();
    } catch (e) {
      window.alert(`Gagal memberhentikan: ${(e as Error).message}`);
    }
  };
  return (
    <div className="directory-body agent-detail">
      <button className="ghost small" onClick={back}><Icon name="collapse" size={14} /> Kembali ke daftar</button>
      <div className="agent-title">
        <Portrait agentId={a.agent_id} size={72} />
        <div>
          <h3>{a.name}</h3>
          <span className="muted">#{a.number} {a.role}{a.hired ? ' · karyawan rekrutan' : ''}</span>
        </div>
      </div>
      <dl className="facts">
        <dt>Divisi</dt><dd className="capitalize">{a.division}</dd>
        <dt>Status</dt><dd><span className="dot" style={{ background: STATUS_DOT[a.status] }} /> {a.status}</dd>
        {a.current_task && a.status !== 'IDLE' && <><dt>Sedang dikerjakan</dt><dd>{a.current_task.title}</dd></>}
        <dt>Tugas</dt><dd>{a.job || '-'}</dd>
        {a.archetype && <><dt>Karakter</dt><dd>{a.archetype}</dd></>}
        <dt>Keahlian</dt><dd className="chips">{(a.skills ?? []).map((s) => <span key={s} className="chip">{s.replace(/_/g, ' ')}</span>)}</dd>
        <dt>Atasan</dt><dd>{boss ? `${boss.name} (${boss.role})` : 'Kamu (Bos)'}</dd>
        {team.length > 0 && <><dt>Tim</dt><dd>{team.map((t) => t.name).join(', ')}</dd></>}
        <dt>Tier model</dt><dd>{a.tier}{a.model ? `, ${a.model}` : ''}</dd>
      </dl>
      <div className="modal-actions">
        {!!a.hired && <button className="ghost" onClick={fire}><Icon name="trash" size={14} /> Berhentikan</button>}
        <button className="ghost" onClick={() => focus(a.agent_id, close)}><Icon name="goal" size={14} /> Lihat di kantor</button>
        {a.kind === 'llm' && <button onClick={() => chatWith(a.agent_id, close)}><Icon name="talk" size={14} /> Chat</button>}
      </div>
    </div>
  );
}

export function Directory({ onClose }: { onClose: () => void }) {
  const agents = useOffice((s) => s.agents);
  const [detail, setDetail] = useState<string | null>(null);
  const [tab, setTab] = useState<'list' | 'org'>('list');
  const [q, setQ] = useState('');
  const all = useMemo(() => Object.values(agents).sort((a, b) => a.number - b.number), [agents]);
  const filtered = all.filter((a) =>
    !q || `${a.name} ${a.role} ${a.job ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  const leadIds = new Set(all.map((a) => a.reports_to).filter(Boolean));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal directory" role="dialog" aria-label="Direktori karyawan" onClick={(e) => e.stopPropagation()}>
        <header className="directory-head">
          <h2><Icon name="users" size={20} /> Karyawan CyberVerse Corp <span className="muted">({all.length} agen)</span></h2>
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'list'} className={tab === 'list' ? '' : 'ghost'} onClick={() => setTab('list')}>Daftar per departemen</button>
            <button role="tab" aria-selected={tab === 'org'} className={tab === 'org' ? '' : 'ghost'} onClick={() => setTab('org')}>Hierarki</button>
          </div>
          <button className="ghost small" onClick={onClose} aria-label="Tutup"><Icon name="close" size={14} /></button>
        </header>

        {detail && agents[detail] ? (
          <AgentDetail a={agents[detail]} all={all} back={() => setDetail(null)} close={onClose} />
        ) : tab === 'list' ? (
          <>
            <input className="directory-search" placeholder="Cari nama, jabatan, atau tugas…" value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="directory-body">
              {DIVISIONS.map(([div, icon, title]) => {
                const rows = filtered.filter((a) => a.division === div);
                if (!rows.length) return null;
                return (
                  <section key={div} className="dept">
                    <h3 style={{ borderColor: DIVISION_COLOR[div] }}><Icon name={icon} /> {title} <span className="muted">· {rows.length} orang</span></h3>
                    <table>
                      <thead>
                        <tr><th>#</th><th>Nama</th><th>Jabatan</th><th>Tugas</th><th>Status</th><th>Aksi</th></tr>
                      </thead>
                      <tbody>
                        {rows.map((a) => (
                          <tr key={a.agent_id} onClick={() => focus(a.agent_id, onClose)} tabIndex={0}
                            onKeyDown={(e) => e.key === 'Enter' && focus(a.agent_id, onClose)}>
                            <td className="muted">{a.number}</td>
                            <td className="person"><Portrait agentId={a.agent_id} size={26} /> <b>{a.name}</b>{leadIds.has(a.agent_id) && <span className="lead-badge">Lead</span>}</td>
                            <td>{a.role}</td>
                            <td className="job">{a.job}</td>
                            <td><span className="dot" style={{ background: STATUS_DOT[a.status] }} /> {a.status}</td>
                            <td className="row-actions" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                              <button className="ghost small" onClick={() => setDetail(a.agent_id)} title={`Detail ${a.name}`}>
                                <Icon name="info" size={13} /> Detail
                              </button>
                              {a.kind === 'llm' && (
                                <button className="ghost small" onClick={() => chatWith(a.agent_id, onClose)} title={`Chat dengan ${a.name}`}>
                                  <Icon name="talk" size={13} /> Chat
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </section>
                );
              })}
            </div>
          </>
        ) : (
          <div className="directory-body"><OrgChart agents={all} close={onClose} /></div>
        )}
      </div>
    </div>
  );
}
