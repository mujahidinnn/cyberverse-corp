import { beforeEach, describe, expect, it } from 'vitest';
import { useOffice } from './store/officeStore';
import { ingest } from './net/wsClient';
import { buildGrid, chairPosition, findPath } from './data/nav';

const agent = { agent_id: 'agent_ren', number: 1, name: 'Ren', division: 'executive', role: 'CEO', tier: 'T1_REASON',
  kind: 'llm', desk_id: 'desk_exec_02', x: 0, z: -4, rotation_y: 0, status: 'IDLE', emotion_icon: null };

beforeEach(() => {
  useOffice.setState({ lastSeq: null, agents: {}, tasks: {}, goals: {}, approvals: [], bubbles: [] });
  ingest({ v: 1, event: 'SNAPSHOT', seq: 10, payload: { agents: [agent], tasks: [], goals: [], approvals_pending: [] } });
});

describe('ingest', () => {
  it('menerapkan event berurutan, abaikan duplikat, tolak gap', () => {
    expect(ingest({ v: 1, event: 'AGENT_STATE_UPDATE', seq: 11, payload: { agent_id: 'agent_ren', status: 'THINKING' } })).toBe(true);
    expect(useOffice.getState().agents.agent_ren.status).toBe('THINKING');
    expect(ingest({ v: 1, event: 'AGENT_STATE_UPDATE', seq: 11, payload: { agent_id: 'agent_ren', status: 'IDLE' } })).toBe(true);
    expect(useOffice.getState().agents.agent_ren.status).toBe('THINKING');
    expect(ingest({ v: 1, event: 'AGENT_STATE_UPDATE', seq: 13, payload: { agent_id: 'agent_ren', status: 'ERROR' } })).toBe(false);
    expect(useOffice.getState().lastSeq).toBe(11);
  });

  it('approval masuk lalu keluar dari antrean', () => {
    ingest({ v: 1, event: 'APPROVAL_REQUIRED', seq: 11, payload: { request_id: 'r1', agent_id: 'agent_ren' } });
    expect(useOffice.getState().approvals).toHaveLength(1);
    ingest({ v: 1, event: 'APPROVAL_RESOLVED', seq: 12, payload: { request_id: 'r1', status: 'APPROVED' } });
    expect(useOffice.getState().approvals).toHaveLength(0);
  });

  it('maksimal satu balon per agen', () => {
    for (let i = 0; i < 3; i++)
      ingest({ v: 1, event: 'AGENT_DIALOGUE_SPOKEN', seq: 11 + i, payload: { speaker_id: 'agent_ren', text: `hai ${i}`, bubble_style: 'normal_white' } });
    const b = useOffice.getState().bubbles;
    expect(b).toHaveLength(1);
    expect(b[0].text).toBe('hai 2');
  });
});

describe('nav', () => {
  it('path menghindari meja dan berakhir di tujuan', () => {
    const desk = { desk_id: 'd', x: 0, z: 0, rotation_y: 0 };
    const grid = buildGrid([desk]);
    const from = { x: 0, z: -3 };
    const to = chairPosition(desk);
    const path = findPath(grid, from, to);
    expect(path.at(-1)).toEqual(to);
    const crossesDesk = path.some((p) => Math.abs(p.x) < 0.8 && Math.abs(p.z) < 0.4);
    expect(crossesDesk).toBe(false);
  });
});

import { COMMAND_TEMPLATES, fillTemplate, missingRequired } from './data/commandTemplates';

describe('template perintah', () => {
  const t = COMMAND_TEMPLATES.find((x) => x.id === 'landing-page')!;
  it('mengisi placeholder dan membuang baris opsional yang kosong', () => {
    const out = fillTemplate(t, { produk: 'KopiKita', target: 'pekerja remote' });
    expect(out).toContain('produk KopiKita dengan target pengguna pekerja remote');
    expect(out).not.toContain('{{');
    expect(out).not.toContain('Gaya visual');
  });
  it('menandai field wajib yang belum diisi', () => {
    expect(missingRequired(t, { produk: 'X' })).toEqual(['Target pengguna']);
  });
  it('semua template valid: id unik dan placeholder terdefinisi', () => {
    expect(new Set(COMMAND_TEMPLATES.map((x) => x.id)).size).toBe(COMMAND_TEMPLATES.length);
    for (const x of COMMAND_TEMPLATES) {
      const keys = new Set(x.fields.map((f) => f.key));
      for (const m of x.body.matchAll(/\{\{(\w+)\}\}/g)) expect(keys.has(m[1])).toBe(true);
    }
  });
});

describe('chat', () => {
  it('riwayat server yang telat tidak menghapus pesan lokal', () => {
    const { addChat, setChat } = useOffice.getState();
    useOffice.setState({ chats: {} });
    addChat('agent_aoi', { message_id: -1, speaker_id: 'human', content: 'halo' });
    addChat('agent_aoi', { message_id: -2, speaker_id: 'agent_aoi', content: '…', pending: true });
    setChat('agent_aoi', []);
    ingest({ v: 1, event: 'AGENT_CHAT_REPLY', seq: 11, payload: { agent_id: 'agent_aoi', message_id: 2, text: 'hai' } });
    expect(useOffice.getState().chats.agent_aoi.map((m) => m.content)).toEqual(['halo', 'hai']);
    setChat('agent_aoi', [{ message_id: 1, speaker_id: 'human', content: 'halo' }, { message_id: 2, speaker_id: 'agent_aoi', content: 'hai' }]);
    expect(useOffice.getState().chats.agent_aoi).toHaveLength(2);
  });
});

import { PODIUM, isWalkable, slotPosition } from './data/nav';

describe('slot rapat', () => {
  it('50 slot Town Hall unik, di dalam plaza, menghadap podium', () => {
    const pts = Array.from({ length: 50 }, (_, i) => slotPosition(`townhall_${String(i + 1).padStart(2, '0')}`)!);
    expect(new Set(pts.map((p) => `${p.x},${p.z}`)).size).toBe(50);
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(-7);
      expect(p.x).toBeLessThanOrEqual(7);
      expect(p.z).toBeGreaterThanOrEqual(-13);
      expect(p.z).toBeLessThan(PODIUM.z);
      const dx = PODIUM.x - p.x, dz = PODIUM.z - p.z;
      expect(Math.sin(p.yaw) * dx + Math.cos(p.yaw) * dz).toBeGreaterThan(0);
    }
    expect(slotPosition('podium')).toMatchObject(PODIUM);
    expect(slotPosition('desk_eng_01')).toBeNull();
  });
});

import { feedFrom } from './store/feed';

describe('log live', () => {
  const agents = { agent_kenji: { ...agent, agent_id: 'agent_kenji', name: 'Kenji' } } as any;
  const tasks = { t1: { task_id: 't1', title: 'Bangun API', assigned_to: 'agent_kenji', status: 'TODO' } } as any;
  it('mencatat perubahan status task, bukan update lain', () => {
    const item = feedFrom({ v: 1, event: 'TASK_UPDATED', payload: { task_id: 't1', status: 'DONE' } }, agents, tasks)!;
    expect(item.text).toBe('"Bangun API" selesai');
    expect(item.agent_id).toBe('agent_kenji');
    expect(item.tone).toBe('ok');
    expect(feedFrom({ v: 1, event: 'TASK_UPDATED', payload: { task_id: 't1', status: 'TODO' } }, agents, tasks)).toBeNull();
  });
  it('melewati celetukan ambient dan animasi', () => {
    expect(feedFrom({ v: 1, event: 'AGENT_DIALOGUE_SPOKEN', payload: { speaker_id: 'agent_kenji', text: 'x', local: true } }, agents, tasks)).toBeNull();
    expect(feedFrom({ v: 1, event: 'AGENT_STATE_UPDATE', payload: { agent_id: 'agent_kenji' } }, agents, tasks)).toBeNull();
    expect(feedFrom({ v: 1, event: 'AGENT_DIALOGUE_SPOKEN', payload: { speaker_id: 'agent_kenji', listener_id: 'agent_kenji', text: 'Beres.' } }, agents, tasks)!.text).toBe('Ke Kenji (CEO): Beres.');
  });
  it('store menyimpan log saat event diterapkan', () => {
    useOffice.setState({ feed: [] });
    ingest({ v: 1, event: 'APPROVAL_REQUIRED', seq: 11, payload: { request_id: 'r9', agent_id: 'agent_ren', tool_name: 'Docker_CLI' } });
    expect(useOffice.getState().feed.at(-1)).toMatchObject({ text: 'Minta izin: Docker_CLI', agent_id: 'agent_ren' });
  });
});

import { feedFromHistory } from './store/feed';

describe('riwayat log live', () => {
  const agents = { agent_kenji: { ...agent, agent_id: 'agent_kenji', name: 'Kenji' } } as any;
  const ev = (event: string, ts: number, payload: object) => ({ v: 1, event, ts, payload });
  it('membangun ulang baris dari riwayat server dengan jam aslinya', () => {
    const items = feedFromHistory([
      ev('TASK_CREATED', 1000, { task_id: 't1', title: 'Bangun API', assigned_to: 'agent_kenji', status: 'TODO' }),
      ev('TASK_UPDATED', 2000, { task_id: 't1', status: 'TODO' }),
      ev('TASK_UPDATED', 3000, { task_id: 't1', status: 'DONE' }),
    ], agents);
    expect(items.map((i) => [i.at, i.text])).toEqual([[1000, 'Task baru: Bangun API'], [3000, '"Bangun API" selesai']]);
  });
  it('menggabungkan riwayat dengan baris live tanpa duplikat', () => {
    useOffice.setState({ agents, feed: [{ id: 1, at: 3000, kind: 'talk', icon: 'talk', text: 'lama' }, { id: 2, at: 9000, kind: 'talk', icon: 'talk', text: 'baru' }] });
    useOffice.getState().loadHistory([ev('AGENT_DIALOGUE_SPOKEN', 3000, { speaker_id: 'agent_kenji', text: 'lama' })]);
    expect(useOffice.getState().feed.map((f) => f.text)).toEqual(['lama', 'baru']);
  });
});

import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { Markdown } from './hud/Markdown';
import { obstacles } from './data/office';

describe('markdown notulen & laporan', () => {
  it('merender heading, daftar, tabel, dan teks tebal, bukan menampilkan simbol mentah', () => {
    const html = renderToStaticMarkup(createElement(Markdown, {
      text: '# Notulen\n\n## Peserta\n- **Ren** hadir\n- Sora\n\n| Task | PIC |\n|---|---|\n| API | Kenji |\n\n1. Satu\n2. Dua\n\nTeks `kode` biasa.',
    }));
    expect(html).toContain('<h2>Notulen</h2>');
    expect(html).toContain('<li><b>Ren</b> hadir</li>');
    expect(html).toContain('<th>Task</th>');
    expect(html).toContain('<td>Kenji</td>');
    expect(html).toContain('<ol><li>Satu</li><li>Dua</li></ol>');
    expect(html).toContain('<code>kode</code>');
    expect(html).not.toMatch(/##|\*\*|\|/);
  });
  it('tidak menjalankan HTML buatan agen', () => {
    expect(renderToStaticMarkup(createElement(Markdown, { text: '<script>alert(1)</script>' }))).not.toContain('<script>');
  });
});

describe('kursi rapat kickoff', () => {
  it('semua kursi Meeting Room bisa dicapai dan menghadap meja', () => {
    const grid = buildGrid([], obstacles());
    for (let i = 1; i <= 5; i++) {
      const p = slotPosition(`meeting_${String(i).padStart(2, '0')}`)!;
      expect(isWalkable(grid, p.x, p.z)).toBe(true);
      expect(findPath(grid, { x: 20, z: 0 }, p).length).toBeGreaterThan(0);
    }
  });
});

import { appearanceFor } from './data/appearance';
import { chairPosition as chairOf } from './data/nav';

describe('rekrutmen karyawan baru', () => {
  const spare: [number, number, number][] = [
    [-16.5, -11, 180], [-13.5, -11, 180], [-10.5, -11, 180], [10.5, -11, 180], [13.5, -11, 180], [16.5, -11, 180],
    [22, 10.5, -90], [26, 10.5, -90], [22, 13.5, -90], [26, 13.5, -90], [-15, 19, 180], [-12, 19, 180], [-9, 19, 180], [-6, 19, 180],
    [-26, -4.5, -90], [-26, -1.5, -90], [-22, 10.5, -90], [-26, 10.5, -90],
    [-3, 19, 180], [0, 19, 180], [3, 19, 180], [6, 19, 180], [9, 19, 180], [12, 19, 180],
    [22, 16.5, -90], [26, 16.5, -90], [22, 19.5, -90], [26, 19.5, -90], [22, 22.5, -90],
  ];
  it('meja cadangan tidak menabrak dinding atau furnitur, dan kursinya bisa dicapai', () => {
    const grid = buildGrid([], obstacles());
    for (const [x, z, rotation_y] of spare) {
      expect(isWalkable(grid, x, z), `meja ${x},${z}`).toBe(true);
      const chair = chairOf({ desk_id: 'd', x, z, rotation_y } as any);
      expect(isWalkable(grid, chair.x, chair.z), `kursi ${x},${z}`).toBe(true);
      expect(findPath(grid, { x: 20, z: 0 }, chair).length).toBeGreaterThan(0);
    }
  });
  it('AGENT_HIRED menambah agen ke kantor dan ke log, dengan tampilan yang tetap', () => {
    const hired = { agent_id: 'agent_asahi', number: 51, name: 'Asahi', role: 'Rust Engineer', division: 'engineering',
      desk_id: 'desk_eng_13', x: -16.5, z: -11, rotation_y: 180, status: 'IDLE', approved_by: 'hrd' };
    useOffice.getState().applyEvent({ v: 1, event: 'AGENT_HIRED', payload: hired });
    expect(useOffice.getState().agents.agent_asahi.name).toBe('Asahi');
    expect(useOffice.getState().feed.at(-1)?.text).toContain('Karyawan baru: Asahi (Rust Engineer)');
    expect(appearanceFor('agent_asahi', 'engineering', 51)).toEqual(appearanceFor('agent_asahi', 'engineering', 51));
    expect(appearanceFor('agent_x', 'engineering', 52).hairStyle).not.toBe(appearanceFor('agent_asahi', 'engineering', 51).hairStyle);
  });
});

describe('stasiun aktivitas ambient', () => {
  it('setiap slot bisa dituju dan aktivitas berpasangan punya cukup slot', async () => {
    const { STATIONS } = await import('./data/office');
    for (const s of STATIONS) {
      expect(s.slots.length).toBeGreaterThanOrEqual(s.min);
      s.slots.forEach((slot, i) => expect(slotPosition(`st:${s.id}:${i}`)).toMatchObject({ x: slot.x, z: slot.z, station: s }));
    }
    expect(STATIONS.find((s) => s.id === 'pingpong')!.min).toBe(2);
    expect(slotPosition('st:pingpong:9')).toBeNull();
  });
});

import { groupProjects } from './store/officeStore';

describe('arsip proyek', () => {
  it('lanjutan dan percobaan ulang menjadi satu kartu, versi lama menjadi riwayat', () => {
    const g = (goal_id: string, prompt: string, status: string, parent_goal_id: string | null = null) => ({ goal_id, prompt, status, parent_goal_id });
    const finished = [g('goal_5', 'Tambah halaman kontak', 'FAILED', 'goal_3'), g('goal_4', 'Landing page kopikita', 'DONE'),
      g('goal_3', 'Landing page sandbox', 'DONE'), g('goal_1', 'Landing page sandbox ', 'FAILED')];
    const groups = groupProjects(finished, Object.fromEntries(finished.map((x) => [x.goal_id, x])));
    expect(groups.map((p) => [p.title, p.versions.map((x) => x.goal_id)])).toEqual([
      ['Landing page sandbox', ['goal_5', 'goal_3', 'goal_1']], ['Landing page kopikita', ['goal_4']]]);
  });
});
