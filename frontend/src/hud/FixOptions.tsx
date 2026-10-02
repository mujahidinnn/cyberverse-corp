import { useState } from 'react';
import { useOffice, type Goal } from '../store/officeStore';
import { send } from '../net/wsClient';
import { api } from '../net/api';
import { Icon, Loading } from './icons';

interface Recovery {
  diagnosis: string;
  options: { title: string; detail: string; prompt: string }[];
}

const parse = (raw?: string | null): Recovery | null => {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

export function FixOptions({ goal, compact }: { goal: Goal; compact?: boolean }) {
  const recovery = parse(goal.recovery_json);
  const [asking, setAsking] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState('');

  const ask = async () => {
    setAsking(true);
    setError('');
    try {
      await api(`/goals/${goal.goal_id}/recovery`, { method: 'POST' });
    } catch (e) {
      setError((e as Error).message);
    }
    setAsking(false);
  };
  const choose = (title: string, prompt: string) => {
    const payload = { prompt, review_before_run: true, priority: goal.priority ?? 2, parent_goal_id: goal.parent_goal_id ?? undefined };
    if (send('USER_INJECT_GOAL', payload)) {
      setSent(title);
      useOffice.getState().openReport(null);
    }
  };

  if (goal.status !== 'FAILED') return null;
  if (!recovery) {
    return (
      <div className="fix">
        {asking ? <Loading>Tim menyiapkan pilihan perbaikan</Loading> : (
          <button className="small" onClick={ask}><Icon name="lightbulb" size={13} /> Minta rekomendasi perbaikan</button>
        )}
        {error && <small className="tone-bad">{error}</small>}
      </div>
    );
  }
  return (
    <div className="fix">
      <b>Kenapa gagal</b>
      <p>{recovery.diagnosis}</p>
      <b>Pilihan perbaikan</b>
      {sent ? <p className="muted">"{sent}" dikirim ke Ren. Rencananya muncul di papan kerja untuk kamu mulai.</p> : (
        <ul className="fix-options">
          {recovery.options.map((o, i) => (
            <li key={o.title}>
              <div>
                <span className="fix-title">{o.title}{i === 0 && recovery.options.length > 1 && <span className="chip">Disarankan</span>}</span>
                {!compact && <small>{o.detail}</small>}
              </div>
              <button className={i === 0 ? 'small' : 'ghost small'} onClick={() => choose(o.title, o.prompt)} title={o.prompt}>Pilih</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
