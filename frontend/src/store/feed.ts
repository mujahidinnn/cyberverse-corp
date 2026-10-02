import type { AgentState, ServerEvent, Task } from './officeStore';
import type { IconKey } from '../hud/icons';

export type FeedKind = 'goal' | 'task' | 'talk' | 'tool' | 'approval' | 'alert' | 'meeting';

export interface FeedItem {
  id: number;
  at: number;
  kind: FeedKind;
  icon: IconKey;
  text: string;
  agent_id?: string;
  tone?: 'ok' | 'warn' | 'bad';
}

const TASK_LABEL: Record<string, string> = {
  PLANNED: 'direncanakan', TODO: 'masuk antrean', IN_PROGRESS: 'mulai dikerjakan', REVIEW: 'sedang direview',
  MEDIATION: 'dimediasi Kazu', WAITING_APPROVAL: 'menunggu izin', DONE: 'selesai', FAILED: 'gagal', CANCELLED: 'dibatalkan',
};

let feedId = 0;

export function feedFrom(
  e: ServerEvent,
  agents: Record<string, AgentState>,
  tasks: Record<string, Task>,
): FeedItem | null {
  const p = e.payload;
  const who = (id?: string | null) => (id && agents[id] ? `${agents[id].name} (${agents[id].role})` : id ?? 'Sistem');
  const make = (kind: FeedKind, icon: IconKey, text: string, agent_id?: string, tone?: FeedItem['tone']): FeedItem =>
    ({ id: ++feedId, at: e.ts ?? Date.now(), kind, icon, text, agent_id, tone });

  switch (e.event) {
    case 'GOAL_UPDATED': {
      const label: Record<string, string> = {
        PLANNING: 'Goal baru, Ren sedang menyusun roadmap', AWAITING_START: 'Roadmap siap, menunggu START',
        RUNNING: 'Goal mulai dieksekusi', DONE: 'Goal selesai', FAILED: 'Goal gagal', CANCELLED: 'Goal dibatalkan',
      };
      if (p.summary) return make('goal', 'report', 'Laporan hasil dikirim ke bos (buka lewat Kanban)', 'agent_ren', 'ok');
      return make('goal', 'goal', label[p.status] ?? `Goal ${p.status}`, undefined,
        p.status === 'DONE' ? 'ok' : p.status === 'FAILED' ? 'bad' : undefined);
    }
    case 'TASK_CREATED':
      return make('task', 'task', `Task baru: ${p.title}`, p.assigned_to);
    case 'TASK_UPDATED': {
      const prev = tasks[p.task_id];
      if (!p.status || prev?.status === p.status) return null;
      const title = p.title ?? prev?.title ?? p.task_id;
      const owner = p.assigned_to ?? prev?.assigned_to;
      const tone = p.status === 'DONE' ? 'ok' : p.status === 'FAILED' ? 'bad' : p.status === 'WAITING_APPROVAL' ? 'warn' : undefined;
      return make('task', p.status === 'DONE' ? 'done' : p.status === 'FAILED' ? 'failed' : 'task',
        `"${title}" ${TASK_LABEL[p.status] ?? p.status}${p.error ? `: ${String(p.error).slice(0, 80)}` : ''}`, owner, tone);
    }
    case 'AGENT_DIALOGUE_SPOKEN':
      if (p.local) return null;
      return make('talk', 'talk', `${p.listener_id ? `Ke ${who(p.listener_id)}: ` : ''}${p.text}`, p.speaker_id);
    case 'TOOL_EXECUTION_LOG':
      if (p.status === 'RUNNING') return null;
      return make('tool', 'tool', `${p.agent_id === 'system' ? 'Sistem menjalankan' : 'Memakai'} ${p.tool_name} (${p.risk_level}), ${p.status}`,
        p.agent_id === 'system' ? undefined : p.agent_id, p.status === 'SUCCEEDED' ? undefined : 'bad');
    case 'APPROVAL_REQUIRED':
      return make('approval', 'approval', `Minta izin: ${p.tool_name}`, p.agent_id, 'warn');
    case 'APPROVAL_RESOLVED':
      return make('approval', p.status === 'APPROVED' ? 'approved' : 'rejected', `Izin ${p.status}${p.reason ? `: ${p.reason}` : ''}`,
        undefined, p.status === 'APPROVED' ? 'ok' : 'bad');
    case 'SYSTEM_ALERT':
      return make('alert', p.level === 'CRITICAL' ? 'critical' : 'alert', `${p.code}: ${p.message}`, p.agent_id ?? undefined,
        p.level === 'INFO' ? undefined : p.level === 'CRITICAL' ? 'bad' : 'warn');
    case 'AGENT_HIRED':
      return make('alert', 'hire', `Karyawan baru: ${p.name} (${p.role}) bergabung di divisi ${p.division}. ${p.approved_by === 'human' ? 'Disetujui bos.' : 'Diputuskan HRD.'}`, p.agent_id, 'ok');
    case 'MEETING_STARTED':
      if (p.type === 'KICKOFF') return make('meeting', 'meetingRoom', `Rapat kickoff dimulai di Meeting Room (${p.participants?.length ?? 0} peserta)`, 'agent_ren');
      return make('meeting', 'meeting', `All-Hands dimulai (${p.participants?.length ?? 0} hadir, ${p.remote?.length ?? 0} remote)`);
    case 'MEETING_ENDED':
      if (p.type === 'KICKOFF') return make('meeting', 'minutes', p.minutes ? 'Kickoff selesai, pembagian kerja disepakati' : 'Kickoff dibatalkan', 'agent_ren', p.minutes ? 'ok' : 'bad');
      return make('meeting', 'minutes', p.minutes ? 'All-Hands selesai, notulen tersimpan' : 'All-Hands dihentikan');
    default:
      return null;
  }
}

export function feedFromHistory(events: ServerEvent[], agents: Record<string, AgentState>): FeedItem[] {
  const tasks: Record<string, Task> = {};
  const out: FeedItem[] = [];
  for (const e of events) {
    const item = feedFrom(e, agents, tasks);
    if (item) out.push(item);
    if (e.event === 'TASK_CREATED' || e.event === 'TASK_UPDATED') {
      tasks[e.payload.task_id] = { ...tasks[e.payload.task_id], ...e.payload };
    }
  }
  return out;
}
