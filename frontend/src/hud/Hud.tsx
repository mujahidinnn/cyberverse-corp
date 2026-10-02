import { useEffect, useMemo, useRef, useState } from 'react';
import { groupProjects, useOffice, type Goal, type Task } from '../store/officeStore';
import { send } from '../net/wsClient';
import { useTheme } from '../theme';
import { TemplatePicker } from './TemplatePicker';
import { ChatPanel } from './ChatPanel';
import { MeetingControls, QuotaChip, Toasts } from './OpsWidgets';
import { GoalReport } from './GoalReport';
import { Directory } from './Directory';
import { CompanyProfile } from './CompanyProfile';
import { FixOptions } from './FixOptions';
import { api, apiImage } from '../net/api';
import { ActivityLog } from './ActivityLog';
import { Icon, Loading, StatusPill } from './icons';
import { Portrait, withRole } from './Portrait';

const COLUMNS: [string, string[]][] = [
  ['Backlog', ['PLANNED']],
  ['To Do', ['TODO']],
  ['In Progress', ['IN_PROGRESS', 'REVIEW', 'MEDIATION']],
  ['Waiting Approval', ['WAITING_APPROVAL']],
  ['Done', ['DONE']],
  ['Failed / Cancelled', ['FAILED', 'CANCELLED']],
];

const FINISHED = ['DONE', 'FAILED', 'CANCELLED'];

const goalDate = (id: string) => {
  const ms = [...id.replace(/^goal_/, '').slice(0, 10)].reduce((n, c) => n * 32 + '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.indexOf(c), 0);
  return ms > 1.5e12 && ms < Date.now() + 864e5 ? new Date(ms).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
};

const ATTACH_ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,.svg,.txt,.md,.html,.css,.json,.csv';
const MAX_FILES = 6;
const MAX_FILE_MB = 4;

const toBase64 = (f: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
  r.onerror = () => reject(r.error);
  r.readAsDataURL(f);
});

function AttachmentChips({ files, remove }: { files: File[]; remove: (i: number) => void }) {
  const urls = useMemo(() => files.map((f) => (f.type.startsWith('image/') ? URL.createObjectURL(f) : '')), [files]);
  useEffect(() => () => urls.forEach((u) => u && URL.revokeObjectURL(u)), [urls]);
  if (!files.length) return null;
  return (
    <ul className="attach-list">
      {files.map((f, i) => (
        <li key={`${f.name}-${i}`} title={f.name}>
          {urls[i] ? <img src={urls[i]} alt="" /> : <Icon name="docs" size={14} />}
          <span>{f.name}</span>
          <button className="link" onClick={() => remove(i)} aria-label={`Hapus lampiran ${f.name}`}><Icon name="close" size={12} /></button>
        </li>
      ))}
    </ul>
  );
}

const resultOf = (t: Task) =>
  !t.goal_id ? null : t.epic_key === 'DESAIN' && t.status === 'DONE' ? 'design.html' : t.output_ref ?? null;

function ResultPreview({ goalId }: { goalId: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'none'>('loading');
  useEffect(() => {
    let url = '';
    apiImage(`/goals/${goalId}/preview`)
      .then((u) => { url = u; setSrc(u); setState('ok'); })
      .catch(() => setState('none'));
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [goalId]);
  if (state === 'none') return null;
  return (
    <button className="result-preview" onClick={() => useOffice.getState().openReport(goalId)} title="Buka hasil">
      {src ? <img src={src} alt="Preview hasil" /> : <span className="muted"><Icon name="loading" className="spin" /> Menyiapkan preview</span>}
    </button>
  );
}

function GoalActions({ g, onRetry, onContinue, children }: {
  g: Goal; onRetry?: () => void; onContinue?: () => void; children?: React.ReactNode;
}) {
  return (
    <span className="goal-btns">
      {onContinue && g.status === 'DONE' && (
        <button className="small" onClick={onContinue} title="Tambah atau ubah pekerjaan ini sebagai versi baru; versi ini tetap utuh">
          <Icon name="continue" size={13} /> Lanjutkan
        </button>
      )}
      {onRetry && g.prompt && (g.status === 'FAILED' || g.status === 'CANCELLED') && (
        <button className="small" onClick={onRetry} title="Kirim ulang perintah ini ke Ren sebagai proyek baru">
          <Icon name="retry" size={13} /> Ulangi
        </button>
      )}
      {g.status !== 'PLANNING' && (
        <button className="ghost small" onClick={() => useOffice.getState().openReport(g.goal_id)}>
          <Icon name="report" size={13} /> {FINISHED.includes(g.status) ? 'Laporan' : g.summary ? 'Laporan hasil' : 'Rencana kerja'}
        </button>
      )}
      {g.status === 'AWAITING_START' && (
        <button className="small" onClick={() => send('USER_GOAL_COMMAND', { goal_id: g.goal_id, command: 'START' })}>Mulai</button>
      )}
      {!FINISHED.includes(g.status) && (
        <button className="ghost small" onClick={() => send('USER_GOAL_COMMAND', { goal_id: g.goal_id, command: 'CANCEL' })}>Batalkan</button>
      )}
      {children}
    </span>
  );
}

function Kanban({ onClose }: { onClose: () => void }) {
  const tasks = useOffice((s) => s.tasks);
  const goals = useOffice((s) => s.goals);
  const agents = useOffice((s) => s.agents);
  const [prompt, setPrompt] = useState('');
  const [review, setReview] = useState(true);
  const [priority, setPriority] = useState(2);
  const [showTemplates, setShowTemplates] = useState(true);
  const [tab, setTab] = useState<'board' | 'archive'>('board');

  const [sending, setSending] = useState(false);
  const goalCount = Object.keys(goals).length;

  const [continuing, setContinuing] = useState<string | null>(null);
  const [followUp, setFollowUp] = useState('');
  const inject = (text: string, reviewFirst: boolean, prio: number, parent?: string | null) => {
    const payload = { prompt: text, review_before_run: reviewFirst, priority: prio, parent_goal_id: parent ?? undefined };
    if (sending || !send('USER_INJECT_GOAL', payload)) return false;
    setTab('board');
    setSending(true);
    return true;
  };
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState('');
  const picker = useRef<HTMLInputElement>(null);
  const addFiles = (list: FileList | File[]) => {
    const incoming = [...list].filter((f) => ATTACH_ACCEPT.split(',').some((ext) => f.name.toLowerCase().endsWith(ext)) || f.type.startsWith('image/'));
    const tooBig = incoming.filter((f) => f.size > MAX_FILE_MB * 1024 * 1024);
    setFileError(tooBig.length ? `${tooBig.map((f) => f.name).join(', ')} lebih dari ${MAX_FILE_MB} MB.` : '');
    setFiles((cur) => [...cur, ...incoming.filter((f) => !tooBig.includes(f))].slice(0, MAX_FILES));
  };
  const submit = async () => {
    const text = prompt.trim();
    if (text.length < 10 || sending) return;
    if (!files.length) {
      if (inject(text, review, priority)) setPrompt('');
      return;
    }
    setSending(true);
    try {
      const attachments = await Promise.all(files.map(async (f) => ({
        name: f.name.includes('.') ? f.name : `${f.name}.${f.type.split('/')[1] || 'png'}`, data: await toBase64(f) })));
      await api('/goals', { method: 'POST', body: JSON.stringify({ prompt: text, review_before_run: review, priority, attachments }) });
      setPrompt('');
      setFiles([]);
      setTab('board');
    } catch (e) {
      setFileError(`Gagal mengirim: ${(e as Error).message}`);
      setSending(false);
    }
  };
  useEffect(() => {
    if (!sending) return;
    const t = setTimeout(() => setSending(false), 8000);
    return () => clearTimeout(t);
  }, [sending]);
  useEffect(() => setSending(false), [goalCount]);
  const all = Object.values(goals);
  const active = all.filter((g) => !FINISHED.includes(g.status));
  const finished = all.filter((g) => FINISHED.includes(g.status)).sort((x, y) => (x.goal_id < y.goal_id ? 1 : -1));
  const projects = groupProjects(finished, goals);
  const removeProject = async (versions: Goal[]) => {
    if (!window.confirm(`Hapus proyek ini beserta ${versions.length} versi dan semua file hasilnya? Tindakan ini tidak bisa dibatalkan.`)) return;
    try {
      for (const v of versions) await api(`/goals/${v.goal_id}`, { method: 'DELETE' });
    } catch (e) {
      window.alert(`Sebagian tidak terhapus: ${(e as Error).message}`);
    }
  };
  const archived = new Set(finished.map((g) => g.goal_id));
  const board = Object.values(tasks).filter((t: Task) => !t.goal_id || !archived.has(t.goal_id));
  const byStatus = (statuses: string[]) => board.filter((t) => statuses.includes(t.status));
  const ofGoal = (id: string) => Object.values(tasks).filter((t: Task) => t.goal_id === id);

  return (
    <div className="kanban" role="dialog" aria-label="Papan kerja">
      <header className="kanban-head">
        <h2><Icon name="kanban" size={18} /> Papan kerja</h2>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'board'} className={tab === 'board' ? '' : 'ghost'} onClick={() => setTab('board')}>
            Sedang berjalan <span className="count">{board.length}</span>
          </button>
          <button role="tab" aria-selected={tab === 'archive'} className={tab === 'archive' ? '' : 'ghost'} onClick={() => setTab('archive')}>
            Proyek selesai <span className="count">{projects.length}</span>
          </button>
        </div>
        <button className="ghost small close" onClick={onClose} aria-label="Tutup papan kerja"><Icon name="close" size={14} /> <kbd>Esc</kbd></button>
      </header>
      {tab === 'archive' ? (
        <ul className="archive">
          {finished.length === 0 && <li className="muted empty">Belum ada proyek yang selesai. Proyek pindah ke sini setelah selesai, gagal, atau dibatalkan.</li>}
          {projects.map(({ title, versions: [g, ...older] }) => {
            const ts = ofGoal(g.goal_id);
            const errors = ts.filter((t) => t.error);
            const lastGood = g.status === 'DONE' ? null : older.find((o) => o.status === 'DONE');
            const mine = continuing && [g, ...older].some((v) => v.goal_id === continuing);
            return (
              <li key={g.goal_id} className="project">
                <span className="goal-text line-clamp-3" title={title}>{title}</span>
                {g.parent_goal_id && <span className="followup line-clamp-2" title={g.prompt}><Icon name="continue" size={12} /> {g.prompt}</span>}
                {g.status === 'DONE' && <ResultPreview key={g.goal_id} goalId={g.goal_id} />}
                <span className="muted">
                  {[goalDate(g.goal_id), ts.length ? `${ts.filter((t) => t.status === 'DONE').length}/${ts.length} task selesai` : ''].filter(Boolean).join(', ')}
                </span>
                <FixOptions goal={g} compact />
                {g.status === 'FAILED' && (
                  <details className="reason">
                    <summary>Detail teknis</summary>
                    {errors.slice(0, 2).map((t) => <p key={t.task_id} title={t.error!}>{t.title}: {t.error!.slice(0, 180)}</p>)}
                    {errors.length > 2 && <p>dan {errors.length - 2} task lain, lihat laporan.</p>}
                    {errors.length === 0 && <p>{g.summary?.slice(0, 240) ?? 'Penyebab tidak tercatat. Cek tab Alert di Log.'}</p>}
                  </details>
                )}
                {lastGood && (
                  <div className="history-row last-good">
                    <span>Versi berhasil terakhir: {goalDate(lastGood.goal_id)}</span>
                    <button className="ghost small" onClick={() => useOffice.getState().openReport(lastGood.goal_id)}>Laporan</button>
                    <button className="ghost small" onClick={() => setContinuing(lastGood.goal_id)}>Lanjutkan dari sini</button>
                  </div>
                )}
                {older.length > 0 && (
                  <details className="history">
                    <summary>Riwayat ({older.length} versi sebelumnya)</summary>
                    {older.map((o) => (
                      <div key={o.goal_id} className="history-row">
                        <StatusPill status={o.status} />
                        <span className="muted line-clamp-1" title={o.prompt}>{goalDate(o.goal_id)}{o.parent_goal_id ? `, ${o.prompt}` : ''}</span>
                        <button className="ghost small" onClick={() => useOffice.getState().openReport(o.goal_id)}>
                          <Icon name="report" size={13} /> Laporan
                        </button>
                        {o.status === 'DONE' && (
                          <button className="ghost small" onClick={() => setContinuing(o.goal_id)} title="Lanjutkan dari versi ini">
                            <Icon name="continue" size={13} />
                          </button>
                        )}
                      </div>
                    ))}
                  </details>
                )}
                {mine && (
                  <form className="followup-form" onSubmit={(e) => {
                    e.preventDefault();
                    if (followUp.trim().length >= 10 && inject(followUp.trim(), true, g.priority ?? 2, continuing)) {
                      setFollowUp('');
                      setContinuing(null);
                    }
                  }}>
                    <small className="muted">Lanjut dari versi {goalDate(continuing!)}. Versi itu tetap utuh; kalau lanjutan gagal, kamu bisa kembali ke sana.</small>
                    <textarea autoFocus value={followUp} onChange={(e) => setFollowUp(e.target.value)} maxLength={4000}
                      placeholder="Apa yang mau ditambah atau diubah? mis. tambah halaman kontak" aria-label="Pekerjaan lanjutan" />
                    <span className="goal-btns">
                      <button type="button" className="ghost small" onClick={() => setContinuing(null)}>Batal</button>
                      <button className="small" disabled={sending || followUp.trim().length < 10}>Kirim ke Ren</button>
                    </span>
                  </form>
                )}
                <span className="project-foot">
                  <StatusPill status={g.status} />
                  <GoalActions g={g} onRetry={() => inject(g.prompt!, true, g.priority ?? 2, g.parent_goal_id)}
                    onContinue={() => setContinuing(g.goal_id)}>
                    <button className="ghost small icon-only" onClick={() => removeProject([g, ...older])} title="Hapus proyek" aria-label="Hapus proyek">
                      <Icon name="trash" size={13} />
                    </button>
                  </GoalActions>
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <>
          <div className="goal-box">
            <div className="section-head">
              <h3>Perintah untuk Ren (CEO)</h3>
              <button className="ghost small" onClick={() => setShowTemplates((v) => !v)} aria-expanded={showTemplates}>
                {showTemplates ? 'Sembunyikan template' : 'Pakai template'}
              </button>
            </div>
            <div className="composer"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); addFiles(e.clipboardData.files); } }}
                onKeyDown={(e) => e.key === 'Enter' && e.ctrlKey && submit()}
                placeholder="Tulis goal, mis. Buat landing page produk X. Lampirkan gambar atau file referensi dengan tombol klip, tempel, atau seret ke sini."
                aria-label="Perintah untuk Ren"
                maxLength={4000}
                autoFocus
              />
              <AttachmentChips files={files} remove={(i) => setFiles((cur) => cur.filter((_, j) => j !== i))} />
              <div className="composer-bar">
                <input ref={picker} type="file" multiple accept={ATTACH_ACCEPT} hidden
                  onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
                <button className="ghost small icon-only" onClick={() => picker.current?.click()} disabled={files.length >= MAX_FILES}
                  title={`Lampirkan gambar atau file referensi (maks ${MAX_FILES}, ${MAX_FILE_MB} MB per file)`} aria-label="Lampirkan file">
                  <Icon name="attach" size={15} />
                </button>
                <label title="Ren menyusun rencana dulu; pekerjaan baru jalan setelah kamu menekan Mulai">
                  <input type="checkbox" checked={review} onChange={(e) => setReview(e.target.checked)} /> Review dulu
                </label>
                <select value={priority} onChange={(e) => setPriority(Number(e.target.value))} aria-label="Prioritas" title="Prioritas">
                  {[0, 1, 2, 3].map((p) => <option key={p} value={p}>P{p}</option>)}
                </select>
                <button className="send" onClick={submit} disabled={sending || prompt.trim().length < 10} title="Ctrl+Enter">
                  {sending ? <><Icon name="loading" className="spin" /> Mengirim</> : 'Kirim ke Ren'}
                </button>
              </div>
            </div>
            {fileError && <p className="tone-bad small-note">{fileError}</p>}
            {showTemplates && (
              <TemplatePicker
                onApply={(text, t) => {
                  setPrompt(text);
                  setReview(t.review);
                  setPriority(t.priority);
                }}
              />
            )}
          </div>
          <div className="board">
            <ul className="goals">
              {active.map((g) => (
                <li key={g.goal_id} className="project">
                  <span className="goal-text line-clamp-2" title={g.prompt}>{g.prompt ?? g.goal_id}</span>
                  <span className="project-foot">
                    <StatusPill status={g.status} />
                    <GoalActions g={g} />
                  </span>
                </li>
              ))}
            </ul>
            <div className="columns">
              {COLUMNS.map(([title, statuses]) => (
                <section key={title}>
                  <h3>{title} <span className="count">{byStatus(statuses).length}</span></h3>
                  {byStatus(statuses).map((t) => (
                    <article key={t.task_id} className={`card div-${t.division} ${resultOf(t) ? 'clickable' : ''}`}
                      {...(resultOf(t) ? {
                        role: 'button', tabIndex: 0, title: 'Lihat hasil task ini',
                        onClick: () => useOffice.getState().openReport(t.goal_id, resultOf(t)),
                        onKeyDown: (e: React.KeyboardEvent) => e.key === 'Enter' && useOffice.getState().openReport(t.goal_id, resultOf(t)),
                      } : {})}>
                      <div>{t.title}</div>
                      <small className="assignee"><Portrait agentId={t.assigned_to} size={20} /> {withRole(agents[t.assigned_to], t.assigned_to)}</small>
                      <small className="card-meta">
                        <span className="chip">P{t.priority}</span>
                        {statuses.length > 1 && <span className="chip">{t.status === 'IN_PROGRESS' && <Icon name="loading" size={10} className="spin" />} {t.status}</span>}
                      </small>
                      {t.error && <small className="err" title={t.error}>{t.error.slice(0, 120)}</small>}
                      {resultOf(t) && <small className="card-result"><Icon name="report" size={12} /> Lihat hasil</small>}
                    </article>
                  ))}
                </section>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ApprovalModal() {
  const req = useOffice((s) => s.approvals[0]);
  const agent = useOffice((s) => (req ? s.agents[req.agent_id] : undefined));
  const [reason, setReason] = useState('');
  if (!req) return null;
  const hiring = req.tool_name === 'Rekrut_Karyawan';
  const hire = req.tool_input as Record<string, any>;

  const decide = (decision: 'APPROVE' | 'REJECT') => {
    send('USER_APPROVAL_RESPONSE', { request_id: req.request_id, decision, reason: reason || undefined });
    setReason('');
  };

  return (
    <div className="modal-backdrop">
      <div className={hiring ? 'modal' : 'modal approval'} role="dialog" aria-modal="true" aria-labelledby="approval-title">
        <div className="approval-head">
          <Portrait agentId={req.agent_id} size={56} />
          {hiring ? (
            <h2 id="approval-title"><Icon name="hire" size={20} /> {withRole(agent, req.agent_id)} minta persetujuan rekrut</h2>
          ) : (
            <h2 id="approval-title"><Icon name="approval" size={20} className="tone-bad" /> Risiko tinggi: {withRole(agent, req.agent_id)} meminta izin</h2>
          )}
        </div>
        {hiring ? (
          <dl className="facts">
            <dt>Jabatan</dt><dd>{hire.jabatan}</dd>
            <dt>Divisi</dt><dd>{hire.divisi}</dd>
            <dt>Keahlian</dt><dd>{(hire.keahlian ?? []).join(', ')}</dd>
            <dt>Untuk task</dt><dd>{hire.untuk_task}</dd>
            <dt>Diminta oleh</dt><dd>{hire.diminta_oleh}</dd>
          </dl>
        ) : (
          <>
            <p className="muted">{req.tool_name} · {req.escalation_reason}</p>
            <pre>{JSON.stringify(req.tool_input, null, 2)}</pre>
          </>
        )}
        {hiring && <p className="muted">{req.escalation_reason}</p>}
        {req.justification && <p>Alasan: {req.justification}</p>}
        <p className="muted">Kedaluwarsa: {new Date(req.expires_at).toLocaleTimeString()}</p>
        <input placeholder="Alasan penolakan (opsional)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <div className="modal-actions">
          <button className="ghost" onClick={() => decide('REJECT')}>{hiring ? 'Jangan rekrut' : 'Tolak'}</button>
          <button className="approve" onClick={() => decide('APPROVE')}>{hiring ? 'Setuju rekrut' : 'Setujui'}</button>
        </div>
      </div>
    </div>
  );
}

function AgentPanel() {
  const agent = useOffice((s) => (s.selected ? s.agents[s.selected] : undefined));
  const select = useOffice((s) => s.select);
  if (!agent) return null;
  return (
    <aside className="agent-panel">
      <button className="ghost close" onClick={() => select(null)} aria-label="Tutup"><Icon name="close" size={14} /></button>
      <div className="agent-title">
        <Portrait agentId={agent.agent_id} size={52} />
        <div>
          <h3>{agent.name}</h3>
          <span className="muted">#{agent.number} {agent.role}</span>
        </div>
      </div>
      <dl className="facts">
        <dt>Status</dt><dd>{agent.status}</dd>
        <dt>Divisi</dt><dd className="capitalize">{agent.division}</dd>
        <dt>Tier</dt><dd>{agent.tier} ({agent.kind})</dd>
        {agent.model && <><dt>Model</dt><dd>{agent.model}</dd></>}
        {agent.current_task && agent.status !== 'IDLE' && <><dt>Task</dt><dd>{agent.current_task.title}</dd></>}
      </dl>
      {agent.kind === 'llm' && (
        <button onClick={() => useOffice.getState().openChat(agent.agent_id)}><Icon name="talk" /> Chat dengan {agent.name}</button>
      )}
    </aside>
  );
}

function Stat({ n, label, color, alert }: { n: number; label: string; color: string; alert?: boolean }) {
  return (
    <span className={`stat ${n ? (alert ? 'alert' : '') : 'zero'}`}>
      <i className="dot" style={{ background: color }} /> <b>{n}</b> {label}
    </span>
  );
}

export function Hud() {
  const [kanban, setKanban] = useState(false);
  const [directory, setDirectory] = useState(false);
  const [company, setCompany] = useState(false);
  const connected = useOffice((s) => s.connected);
  const pending = useOffice((s) => s.approvals.length);
  const agents = useOffice((s) => s.agents);
  const { theme, toggle } = useTheme();
  const near = useOffice((s) => (s.nearAgent ? s.agents[s.nearAgent] : undefined));
  const chatting = useOffice((s) => s.chatWith);
  const follow = useOffice((s) => s.follow);
  const count = (...st: string[]) => Object.values(agents).filter((a) => st.includes(a.status)).length;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest?.('input, textarea, select, button, [contenteditable]');
      if (e.key === 'Tab' && !typing) {
        e.preventDefault();
        setKanban((k) => !k);
      }
      if (e.key === 'Escape') {
        setKanban(false);
        setDirectory(false);
        setCompany(false);
        useOffice.getState().openChat(null);
      }
      if (typing) return;
      const st = useOffice.getState();
      if (e.key.toLowerCase() === 'e' && st.nearAgent) {
        e.preventDefault();
        st.openChat(st.nearAgent);
      }
      if (e.key.toLowerCase() === 'f') st.toggleFollow();
      if (e.key.toLowerCase() === 'o') setDirectory((d) => !d);
      if (e.key.toLowerCase() === 'm' && !st.meeting?.running &&
          window.confirm('Panggil All-Hands Meeting? Agen yang idle akan berkumpul di Town Hall.')) {
        send('USER_START_MEETING', { type: 'ALL_HANDS' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <header className="topbar">
        <span className="brand">
          <span className={connected ? 'dot on' : 'dot'} title={connected ? 'Terhubung' : 'Menyambung ulang'} /> CyberVerse
        </span>
        {!connected && <span className="muted" role="status"><Icon name="loading" className="spin" /> Menyambung ulang</span>}
        <span className="status-pill max-lg:hidden" aria-label="Ringkasan status agen">
          <Stat n={count('WORKING', 'THINKING', 'TALKING')} label="bekerja" color="#22c55e" />
          <Stat n={count('IDLE')} label="idle" color="#94a3b8" />
          {count('MEETING') > 0 && <Stat n={count('MEETING')} label="rapat" color="#0ea5e9" />}
          <Stat n={count('QUEUED')} label="antre" color="#64748b" />
          <Stat n={pending} label="izin" color="#ef4444" alert />
          <Stat n={count('ERROR')} label="error" color="#b91c1c" />
        </span>
        <span className="spacer" />
        <QuotaChip />
        <button className="ghost" onClick={() => setCompany(true)} title="Profil perusahaan" aria-label="Profil perusahaan">
          <Icon name="executive" /> <span className="max-xl:hidden">Profil</span>
        </button>
        <button className="ghost" onClick={() => setDirectory(true)} title="Karyawan (tombol O)" aria-label="Karyawan">
          <Icon name="users" /> <span className="max-xl:hidden">Karyawan</span>
        </button>
        <MeetingControls />
        <button className="ghost" onClick={toggle} aria-label="Ganti tema" title="Ganti tema">
          <Icon name={theme === 'light' ? 'moon' : 'sun'} /> <span className="max-xl:hidden">{theme === 'light' ? 'Gelap' : 'Terang'}</span>
        </button>
        <button onClick={() => setKanban((k) => !k)}><Icon name="kanban" /> Papan kerja <kbd>Tab</kbd></button>
      </header>
      {Object.keys(agents).length === 0 && <div className="boot"><Loading>Menyiapkan kantor</Loading></div>}
      {kanban && <Kanban onClose={() => setKanban(false)} />}
      {near && !chatting && !kanban && (
        <div className="interact-prompt" role="status">
          <kbd>E</kbd> Bicara dengan <b>{near.name}</b> <span className="muted">({near.role})</span>
        </div>
      )}
      <div className="controls-hint max-md:hidden" aria-hidden>
        <span><kbd>W A S D</kbd> jalan</span>
        <span><kbd>Shift</kbd> lari</span>
        <span><kbd>F</kbd> kamera {follow ? 'ikut' : 'bebas'}</span>
        <span><kbd>E</kbd> bicara</span>
        <span><kbd>M</kbd> All-Hands</span>
        <span><kbd>O</kbd> karyawan</span>
      </div>
      {directory && <Directory onClose={() => setDirectory(false)} />}
      {company && <CompanyProfile onClose={() => setCompany(false)} />}
      <GoalReport />
      <ActivityLog />
      <Toasts />
      <AgentPanel />
      <ChatPanel />
      <ApprovalModal />
    </>
  );
}
