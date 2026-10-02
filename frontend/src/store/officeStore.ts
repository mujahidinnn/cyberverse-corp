import { create } from 'zustand';
import { feedFrom, feedFromHistory, type FeedItem } from './feed';

export type AgentStatus =
  | 'IDLE' | 'MOVING' | 'THINKING' | 'QUEUED' | 'WORKING'
  | 'WAITING_APPROVAL' | 'TALKING' | 'MEETING' | 'ERROR' | 'OFFLINE';

export interface AgentState {
  agent_id: string;
  number: number;
  name: string;
  division: string;
  role: string;
  tier: string;
  kind: string;
  desk_id: string;
  x: number;
  z: number;
  rotation_y: number;
  status: AgentStatus;
  emotion_icon: string | null;
  current_task?: { task_id: string; title: string } | null;
  model?: string;
  ambient_lines?: string[];
  job?: string;
  skills?: string[];
  archetype?: string;
  hired?: number | boolean;
  reports_to?: string | null;
  move?: { target: string; n: number; ambient?: boolean } | null;
}

export interface Task {
  task_id: string;
  goal_id: string | null;
  title: string;
  division: string;
  assigned_to: string;
  status: string;
  priority: number;
  iteration: number;
  error?: string | null;
  output_ref?: string | null;
  epic_key?: string | null;
}

export interface Goal {
  goal_id: string;
  prompt?: string;
  status: string;
  priority?: number;
  report_path?: string | null;
  summary?: string | null;
  parent_goal_id?: string | null;
  recovery_json?: string | null;
}

export function groupProjects(finished: Goal[], all: Record<string, Goal>): { title: string; versions: Goal[] }[] {
  const rootOf = (g: Goal) => {
    const seen = new Set<string>();
    while (g.parent_goal_id && all[g.parent_goal_id] && !seen.has(g.goal_id)) {
      seen.add(g.goal_id);
      g = all[g.parent_goal_id];
    }
    return g;
  };
  const groups = new Map<string, { title: string; versions: Goal[] }>();
  for (const g of finished) {
    const root = rootOf(g);
    const key = root.prompt?.trim() || root.goal_id;
    const group = groups.get(key) ?? { title: root.prompt ?? root.goal_id, versions: [] };
    group.versions.push(g);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export interface QuotaModel {
  model: string;
  rpd_used: number;
  rpd_limit: number | null;
  rpd_pct_left: number | null;
  in_flight: number;
  cooldown_until: number | null;
}

export interface Health {
  cpu_pct: number;
  ram_pct: number;
  disk_pct: number;
  ws_clients: number;
  ollama_up?: boolean;
}

export interface Alert {
  id: number;
  level: 'INFO' | 'WARN' | 'CRITICAL';
  code: string;
  message: string;
  agent_id?: string | null;
}

export interface Meeting {
  meeting_id: string;
  running: boolean;
  minutes?: string | null;
}

export interface Approval {
  request_id: string;
  agent_id: string;
  task_id: string | null;
  tool_name: string;
  tool_input: Record<string, unknown>;
  escalation_reason?: string | null;
  justification?: string | null;
  explanation?: string | null;
  expires_at: string;
}

export interface Bubble {
  id: number;
  speaker_id: string;
  text: string;
  style: string;
  expiresAt: number;
}

export interface ChatMessage {
  message_id: number;
  speaker_id: string;
  content: string;
  pending?: boolean;
}

export interface ServerEvent {
  v: number;
  event: string;
  seq?: number;
  ts?: number;
  payload: any;
}

const MAX_BUBBLES = 8;
const MAX_FEED = 300;
let bubbleId = 0;
let moveN = 0;
let alertId = 0;

interface OfficeStore {
  connected: boolean;
  lastSeq: number | null;
  agents: Record<string, AgentState>;
  tasks: Record<string, Task>;
  goals: Record<string, Goal>;
  approvals: Approval[];
  bubbles: Bubble[];
  selected: string | null;
  chats: Record<string, ChatMessage[]>;
  chatWith: string | null;
  nearAgent: string | null;
  follow: boolean;
  quota: QuotaModel[];
  health: Health | null;
  alerts: Alert[];
  meeting: Meeting | null;
  feed: FeedItem[];
  clearFeed: () => void;
  lod: boolean;
  setLod: (lod: boolean) => void;
  dismissAlert: (id: number) => void;
  sayLocal: (agentId: string, text: string) => void;
  ambientMove: (agentId: string, target: string) => void;
  ceoTarget: { x: number; z: number; n: number } | null;
  setChat: (agentId: string, msgs: ChatMessage[]) => void;
  addChat: (agentId: string, msg: ChatMessage) => void;
  openChat: (agentId: string | null) => void;
  setNear: (agentId: string | null) => void;
  toggleFollow: () => void;
  moveCeo: (x: number, z: number) => void;
  setConnected: (c: boolean) => void;
  select: (id: string | null) => void;
  applyEvent: (e: ServerEvent) => void;
  loadHistory: (events: ServerEvent[]) => void;
  report: string | null;
  reportFile: string | null;
  openReport: (goalId: string | null, file?: string | null) => void;
  expireBubbles: () => void;
}

export const useOffice = create<OfficeStore>((set, get) => ({
  connected: false,
  lastSeq: null,
  agents: {},
  tasks: {},
  goals: {},
  approvals: [],
  bubbles: [],
  selected: null,
  chats: {},
  chatWith: null,
  nearAgent: null,
  follow: false,
  quota: [],
  health: null,
  alerts: [],
  meeting: null,
  feed: [],
  clearFeed: () => set({ feed: [] }),
  report: null,
  reportFile: null,
  openReport: (report, file = null) => set({ report, reportFile: file }),
  loadHistory: (events) =>
    set((s) => {
      const history = feedFromHistory(events, s.agents);
      const last = history.at(-1)?.at ?? 0;
      return { feed: [...history, ...s.feed.filter((f) => f.at > last)].slice(-MAX_FEED) };
    }),
  lod: false,
  setLod: (lod) => set({ lod }),
  dismissAlert: (id) => set((s) => ({ alerts: s.alerts.filter((a) => a.id !== id) })),
  sayLocal: (agentId, text) =>
    get().applyEvent({ v: 1, event: 'AGENT_DIALOGUE_SPOKEN', payload: { speaker_id: agentId, text, bubble_style: 'thought_cloud', local: true } }),
  ceoTarget: null,
  ambientMove: (agentId, target) =>
    set((s) => {
      const prev = s.agents[agentId];
      return prev ? { agents: { ...s.agents, [agentId]: { ...prev, move: { target, n: ++moveN, ambient: true } } } } : {};
    }),
  setChat: (agentId, msgs) =>
    set((s) => {
      const known = new Set(msgs.map((m) => `${m.speaker_id}|${m.content}`));
      const local = (s.chats[agentId] ?? []).filter(
        (m) => m.message_id < 0 && (m.pending || !known.has(`${m.speaker_id}|${m.content}`)),
      );
      return { chats: { ...s.chats, [agentId]: [...msgs, ...local] } };
    }),
  addChat: (agentId, msg) =>
    set((s) => ({ chats: { ...s.chats, [agentId]: [...(s.chats[agentId] ?? []).filter((m) => !m.pending), msg] } })),
  openChat: (chatWith) => set({ chatWith }),
  setNear: (nearAgent) => set({ nearAgent }),
  toggleFollow: () => set((s) => ({ follow: !s.follow })),
  moveCeo: (x, z) => set((s) => ({ ceoTarget: { x, z, n: (s.ceoTarget?.n ?? 0) + 1 } })),
  setConnected: (connected) => set({ connected }),
  select: (selected) => set({ selected }),

  applyEvent: (e) => {
    const p = e.payload;
    set((s) => {
      const next: Partial<OfficeStore> = {};
      if (typeof e.seq === 'number') next.lastSeq = e.seq;
      const item = feedFrom(e, s.agents, s.tasks);
      if (item) next.feed = [...s.feed, item].slice(-MAX_FEED);
      switch (e.event) {
        case 'SNAPSHOT':
          next.agents = Object.fromEntries(p.agents.map((a: AgentState) => [a.agent_id, a]));
          next.tasks = Object.fromEntries(p.tasks.map((t: Task) => [t.task_id, t]));
          next.goals = Object.fromEntries(p.goals.map((g: Goal) => [g.goal_id, g]));
          next.approvals = p.approvals_pending;
          next.quota = p.quota?.models ?? [];
          next.health = p.health ?? null;
          next.meeting = p.meeting ? { meeting_id: p.meeting.meeting_id, running: true } : null;
          break;
        case 'QUOTA_UPDATE':
          next.quota = p.models;
          break;
        case 'SYSTEM_HEALTH':
          next.health = p;
          break;
        case 'SYSTEM_ALERT': {
          const alert: Alert = { id: ++alertId, ...p };
          next.alerts = [...s.alerts, alert].slice(-5);
          setTimeout(() => get().dismissAlert(alert.id), alert.level === 'CRITICAL' ? 20000 : 10000);
          break;
        }
        case 'MEETING_STARTED':
          if (p.type === 'KICKOFF') break;
          next.meeting = { meeting_id: p.meeting_id, running: true };
          break;
        case 'MEETING_ENDED':
          if (p.type === 'KICKOFF') break;
          next.meeting = { meeting_id: p.meeting_id, running: false, minutes: p.minutes };
          break;
        case 'AGENT_HIRED':
          next.agents = { ...s.agents, [p.agent_id]: p };
          break;
        case 'AGENT_FIRED': {
          const { [p.agent_id]: _gone, ...agents } = s.agents;
          next.agents = agents;
          if (s.selected === p.agent_id) next.selected = null;
          if (s.chatWith === p.agent_id) next.chatWith = null;
          break;
        }
        case 'MEETING_DELETED':
          if (s.meeting?.meeting_id === p.meeting_id) next.meeting = null;
          break;
        case 'AGENT_STATE_UPDATE': {
          const prev = s.agents[p.agent_id];
          if (prev) next.agents = { ...s.agents, [p.agent_id]: { ...prev, ...p } };
          break;
        }
        case 'AGENT_MOVE': {
          const prev = s.agents[p.agent_id];
          if (prev) next.agents = { ...s.agents, [p.agent_id]: { ...prev, move: { target: p.target, n: ++moveN } } };
          break;
        }
        case 'AGENT_DIALOGUE_SPOKEN': {
          const ms = 3000 + 50 * p.text.length;
          const bubble: Bubble = {
            id: ++bubbleId,
            speaker_id: p.speaker_id,
            text: p.text.length > 140 ? p.text.slice(0, 139) + '…' : p.text,
            style: p.bubble_style,
            expiresAt: Date.now() + ms,
          };
          next.bubbles = [...s.bubbles.filter((b) => b.speaker_id !== p.speaker_id), bubble].slice(-MAX_BUBBLES);
          setTimeout(() => get().expireBubbles(), ms + 50);
          break;
        }
        case 'TASK_CREATED':
        case 'TASK_UPDATED':
          next.tasks = { ...s.tasks, [p.task_id]: { ...s.tasks[p.task_id], ...p } };
          break;
        case 'GOAL_DELETED': {
          const { [p.goal_id]: _gone, ...goals } = s.goals;
          next.goals = goals;
          next.tasks = Object.fromEntries(Object.entries(s.tasks).filter(([, t]) => t.goal_id !== p.goal_id));
          break;
        }
        case 'GOAL_UPDATED':
          next.goals = { ...s.goals, [p.goal_id]: { ...s.goals[p.goal_id], ...p } };
          if (p.summary) next.report = p.goal_id;
          break;
        case 'AGENT_CHAT_REPLY': {
          const msg: ChatMessage = { message_id: p.message_id, speaker_id: p.agent_id, content: p.text };
          next.chats = { ...s.chats, [p.agent_id]: [...(s.chats[p.agent_id] ?? []).filter((m) => !m.pending), msg] };
          break;
        }
        case 'APPROVAL_REQUIRED':
          next.approvals = [...s.approvals, p];
          break;
        case 'APPROVAL_UPDATED':
          next.approvals = s.approvals.map((a) => (a.request_id === p.request_id ? { ...a, ...p } : a));
          break;
        case 'APPROVAL_RESOLVED':
          next.approvals = s.approvals.filter((a) => a.request_id !== p.request_id);
          break;
      }
      return next;
    });
  },

  expireBubbles: () => {
    const now = Date.now();
    set((s) => ({ bubbles: s.bubbles.filter((b) => b.expiresAt > now) }));
  },
}));

if (import.meta.env.DEV && typeof window !== 'undefined') (window as unknown as { __office: typeof useOffice }).__office = useOffice;
