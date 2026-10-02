import { useEffect, useState } from 'react';
import { useOffice } from '../store/officeStore';
import { api, apiText, openHtmlInTab } from '../net/api';
import { Icon, Loading, StatusPill } from './icons';
import { Portrait, withRole } from './Portrait';
import { Markdown } from './Markdown';
import { FixOptions } from './FixOptions';

interface Report {
  goal_id: string;
  prompt: string;
  status: string;
  summary: string | null;
  kickoff: string | null;
  report_path: string | null;
  created_at: string;
  finished_at: string | null;
  files: { path: string; size: number }[];
  tasks: { title: string; assigned_to: string; status: string; iteration: number; error: string | null;
    epic_key: string | null; output_ref: string | null }[];
}

const duration = (from: string, to: string | null) => {
  const s = Math.max(0, Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000));
  return s < 60 ? `${s} dtk` : `${Math.floor(s / 60)} mnt ${s % 60} dtk`;
};
const mainFile = (files: { path: string }[]) =>
  files.find((f) => f.path === 'index.html') ?? files.find((f) => f.path.endsWith('.html') && f.path !== 'design.html')
  ?? files.find((f) => /\.(svg|html)$/.test(f.path)) ?? files[0];
const kindOf = (path: string) =>
  path === 'design.html' || path.endsWith('.svg') ? 'Hasil desain' : path.endsWith('.html') ? 'Website' : 'Dokumen hasil';
const size = (b: number) => (b < 1024 ? `${b} B` : `${(b / 1024).toFixed(1)} KB`);

export function GoalReport() {
  const goalId = useOffice((s) => s.report);
  const focusFile = useOffice((s) => s.reportFile);
  const goal = useOffice((s) => (goalId ? s.goals[goalId] : undefined));
  const close = () => useOffice.getState().openReport(null);
  const agents = useOffice((s) => s.agents);
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState('');
  const [file, setFile] = useState<{ path: string; text: string } | null>(null);
  const [opening, setOpening] = useState('');

  const view = async (id: string, path: string) => {
    setOpening(path);
    try {
      setFile({ path, text: await apiText(`/artifacts/${id}/${path}`) });
    } catch (e) {
      setFile({ path, text: `Gagal memuat file: ${(e as Error).message}` });
    }
    setOpening('');
  };

  useEffect(() => {
    setData(null);
    setFile(null);
    setError('');
    if (!goalId) return;
    api<Report>(`/goals/${goalId}/report`)
      .then((r) => {
        setData(r);
        const first = focusFile ?? mainFile(r.files)?.path;
        if (first) view(goalId, first);
      })
      .catch((e) => setError((e as Error).message));
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goalId, focusFile]);

  if (!goalId) return null;
  const done = data?.tasks.filter((t) => t.status === 'DONE').length ?? 0;
  const revisions = data?.tasks.reduce((n, t) => n + t.iteration, 0) ?? 0;
  const main = data && mainFile(data.files);
  const openTab = async (id: string, path: string) =>
    openHtmlInTab(file?.path === path ? file.text : await apiText(`/artifacts/${id}/${path}`), path);

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal report" role="dialog" aria-modal="true" aria-labelledby="report-title" onClick={(e) => e.stopPropagation()}>
        <header className="report-head">
          <h2 id="report-title"><Icon name="report" size={20} /> {data && !data.summary ? 'Rencana Kerja' : 'Laporan Hasil'}</h2>
          {data && <StatusPill status={data.status} />}
          <button className="ghost close" onClick={close} aria-label="Tutup laporan"><Icon name="close" size={14} /></button>
        </header>
        {error && <p className="tone-bad">Gagal memuat laporan: {error}</p>}
        {!data && !error && <Loading>Memuat laporan</Loading>}
        {data && (
          <div className="report-body">
            <section className="report-left">
              <p className="report-prompt">{data.prompt}</p>
              <div className="report-stats">
                <span><Icon name="busy" size={13} /> {duration(data.created_at, data.finished_at)}</span>
                <span><Icon name="done" size={13} /> {done}/{data.tasks.length} task selesai</span>
                <span><Icon name="task" size={13} /> {revisions} revisi</span>
              </div>
              {goal && <FixOptions goal={goal} />}
              {main && (
                <div className="report-main">
                  <b>{kindOf(main.path)}</b>
                  <span className="goal-btns">
                    <button className="ghost small" onClick={() => view(data.goal_id, main.path)}>
                      <Icon name={main.path.endsWith('.md') ? 'docs' : 'globe'} size={13} /> Lihat {main.path}
                    </button>
                    {main.path.endsWith('.html') && (
                      <button className="small" onClick={() => openTab(data.goal_id, main.path)}>Buka di tab baru</button>
                    )}
                  </span>
                </div>
              )}
              {data.summary ? (
                <>
                  <h3>Ringkasan</h3>
                  <Markdown text={data.summary} />
                </>
              ) : (
                <p className="muted">Pekerjaan belum selesai. Laporan hasil muncul di sini setelah semua task beres.</p>
              )}
              {data.kickoff && (
                <details open={!data.summary}>
                  <summary>Kesepakatan rapat kickoff</summary>
                  <Markdown text={data.kickoff} />
                </details>
              )}
              <h3>Dikerjakan oleh</h3>
              <ul className="report-tasks">
                {data.tasks.map((t, i) => {
                  const out = t.epic_key === 'DESAIN' && t.status === 'DONE' ? 'design.html' : t.output_ref;
                  return (
                    <li key={i}>
                      <Portrait agentId={t.assigned_to} size={24} />
                      <div>
                        <b>{t.title}</b>
                        <small>
                          {withRole(agents[t.assigned_to], t.assigned_to)} · {t.status}
                          {t.iteration > 0 && ` · ${t.iteration} revisi`}
                          {t.error && ` · ${t.error.slice(0, 100)}`}
                        </small>
                      </div>
                      {out && (
                        <button className={`ghost small ${file?.path === out ? 'active' : ''}`} onClick={() => view(data.goal_id, out)}>
                          Lihat hasil
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
              <h3>Lampiran hasil</h3>
              {data.files.length === 0 && !data.report_path && <p className="muted">Tidak ada file hasil.</p>}
              <ul className="report-files">
                {data.files.map((f) => (
                  <li key={f.path}>
                    <button className={`ghost small ${file?.path === f.path ? 'active' : ''}`} onClick={() => view(data.goal_id, f.path)}>
                      <Icon name={f.path.endsWith('.html') ? 'globe' : 'docs'} size={13} /> {f.path} <span className="muted">{size(f.size)}</span>
                    </button>
                  </li>
                ))}
                {data.report_path && (
                  <li>
                    <button className={`ghost small ${file?.path === data.report_path ? 'active' : ''}`} onClick={() => view(data.goal_id, data.report_path!)}>
                      <Icon name="report" size={13} /> Laporan lengkap per task
                    </button>
                  </li>
                )}
              </ul>
              {data.files.length > 0 && <small className="muted">Folder: workspace/{data.goal_id}/</small>}
            </section>
            <section className="report-right">
              {opening ? (
                <Loading>Membuka {opening}</Loading>
              ) : file ? (
                <>
                  <div className="report-file-name">
                    {file.path}
                    {file.path.endsWith('.html') && (
                      <button className="ghost small" onClick={() => openHtmlInTab(file.text, file.path)}>Buka di tab baru</button>
                    )}
                  </div>
                  {file.path.endsWith('.svg') ? (
                    <img className="report-image" alt={`Desain ${file.path}`} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(file.text)}`} />
                  ) : file.path.endsWith('.html') ? (
                    <iframe title={`Pratinjau ${file.path}`} sandbox="allow-scripts" srcDoc={file.text} />
                  ) : file.path.endsWith('.md') ? (
                    <div className="doc-scroll"><Markdown text={file.text} /></div>
                  ) : (
                    <pre>{file.text}</pre>
                  )}
                </>
              ) : (
                <p className="muted">Pilih file di kiri untuk melihat isinya.</p>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
