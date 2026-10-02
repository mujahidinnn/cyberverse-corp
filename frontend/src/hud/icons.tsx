import {
  UserPlus,
  BatteryMedium, BookOpen, Brain, Bug, ChartColumn, ChevronLeft, CircleCheck, CircleX, Clapperboard, ClipboardList, Coffee,
  Cog, Crown, Dumbbell, FileText, LoaderCircle, RotateCcw, FlaskConical, FolderKanban, Globe, Info, Kanban, Landmark, Laptop, Lightbulb, Megaphone,
  MessageCircle, Mic, Moon, NotebookPen, Palette, PenLine, Plug, Presentation, Radio, Search, Shield, ShieldAlert,
  ShieldCheck, ShieldX, Siren, Snowflake, Sofa, Star, Sun, Target, Trash2, TrendingUp, TriangleAlert, Users, Wrench, X,
  CornerDownRight, Paperclip,
} from 'lucide-react';

export const ICONS = {
  trash: Trash2, attach: Paperclip, lightbulb: Lightbulb, continue: CornerDownRight, goal: Target, report: FileText, task: ClipboardList, done: CircleCheck, failed: CircleX, talk: MessageCircle,
  tool: Wrench, approval: ShieldAlert, approved: ShieldCheck, rejected: ShieldX, alert: TriangleAlert,
  critical: Siren, info: Info, meeting: Mic, minutes: NotebookPen, live: Radio, quota: BatteryMedium,
  busy: Cog, loading: LoaderCircle, retry: RotateCcw, cooldown: Snowflake, users: Users, hire: UserPlus, kanban: Kanban, moon: Moon, sun: Sun, close: X, collapse: ChevronLeft,
  executive: Landmark, engineering: Laptop, creative: Palette, marketing: TrendingUp, operations: FolderKanban,
  boss: Crown, pantry: Coffee, healing: Dumbbell, lobby: Sofa, security: Shield, meetingRoom: Presentation,
  townhall: Megaphone, cto: Brain, ceo: Star, cpo: Lightbulb,
  globe: Globe, plug: Plug, bug: Bug, test: FlaskConical, campaign: Megaphone, search: Search, write: PenLine,
  video: Clapperboard, docs: BookOpen, chart: ChartColumn,
} as const;

export type IconKey = keyof typeof ICONS;

export function Icon({ name, size = 16, className }: { name: IconKey; size?: number; className?: string }) {
  const C = ICONS[name];
  return <C size={size} strokeWidth={2} aria-hidden className={`icon ${className ?? ''}`} />;
}

export function Loading({ children }: { children: React.ReactNode }) {
  return <p className="loading" role="status"><Icon name="loading" className="spin" /> {children}</p>;
}

const STATUS_LABEL: Record<string, string> = {
  PLANNING: 'Menyusun rencana', AWAITING_START: 'Menunggu mulai', RUNNING: 'Berjalan', DONE: 'Selesai', FAILED: 'Gagal', CANCELLED: 'Dibatalkan',
};

export function StatusPill({ status }: { status: string }) {
  return (
    <span className={`pill pill-${status}`}>
      {(status === 'PLANNING' || status === 'RUNNING') && <Icon name="loading" size={11} className="spin" />}
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}
