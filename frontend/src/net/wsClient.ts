import { useOffice, type ServerEvent } from '../store/officeStore';

const WS_URL = (import.meta.env.VITE_WS_URL as string) ?? 'ws://localhost:8010/ws/office';
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const PING_EVERY_MS = 20_000;
const PONG_TIMEOUT_MS = 45_000;

let socket: WebSocket | null = null;

export function send(event: string, payload: object): boolean {
  if (socket?.readyState !== WebSocket.OPEN) {
    console.warn(`WS belum terbuka, ${event} tidak terkirim`);
    return false;
  }
  socket.send(JSON.stringify({ v: 1, event, payload }));
  return true;
}

export function ingest(e: ServerEvent): boolean {
  const { lastSeq, applyEvent } = useOffice.getState();
  if (e.event !== 'SNAPSHOT' && typeof e.seq === 'number' && lastSeq !== null) {
    if (e.seq <= lastSeq) return true;
    if (e.seq > lastSeq + 1) return false;
  }
  applyEvent(e);
  return true;
}

export function connectOffice(token: string, onUnauthorized: () => void): () => void {
  let attempt = 0;
  let pingTimer: number | undefined;
  let lastPong = Date.now();
  let resyncing = false;
  let closedByUser = false;

  const open = () => {
    const ws = new WebSocket(WS_URL);
    socket = ws;

    ws.onopen = () => {
      attempt = 0;
      lastPong = Date.now();
      resyncing = false;
      const lastSeq = useOffice.getState().lastSeq;
      send('AUTH', lastSeq === null ? { token } : { token, last_seq: lastSeq });
      pingTimer = window.setInterval(() => {
        if (Date.now() - lastPong > PONG_TIMEOUT_MS) return ws.close();
        send('PING', { client_ts: Date.now() });
      }, PING_EVERY_MS);
    };

    ws.onmessage = (msg) => {
      const e: ServerEvent = JSON.parse(msg.data);
      if (e.event === 'PONG') {
        lastPong = Date.now();
        return;
      }
      if (e.event === 'HELLO') {
        useOffice.getState().setConnected(true);
        return;
      }
      if (e.event === 'ERROR') {
        console.warn('server error', e.payload);
        return;
      }
      if (ingest(e)) {
        resyncing = false;
      } else if (!resyncing) {
        resyncing = true;
        send('REQUEST_RESYNC', { last_seq: useOffice.getState().lastSeq });
      }
    };

    ws.onclose = (ev) => {
      window.clearInterval(pingTimer);
      useOffice.getState().setConnected(false);
      if (closedByUser) return;
      if (ev.code === 4401) return onUnauthorized();
      const base = BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)];
      window.setTimeout(open, base * (0.8 + Math.random() * 0.4));
    };
  };

  open();
  return () => {
    closedByUser = true;
    socket?.close();
  };
}
