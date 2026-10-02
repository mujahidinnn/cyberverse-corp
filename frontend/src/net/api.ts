const API_URL = (import.meta.env.VITE_API_URL as string) ?? 'http://localhost:8010/api/v1';

let token = '';

export function setApiToken(t: string): void {
  token = t;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...init.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.detail?.message ?? `HTTP ${res.status}`);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export function openHtmlInTab(html: string, title: string): void {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const page = `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>` +
    '<style>html,body,iframe{margin:0;width:100%;height:100%;border:0;display:block}</style>' +
    `<iframe sandbox="allow-scripts" srcdoc="${esc(html)}"></iframe>`;
  const url = URL.createObjectURL(new Blob([page], { type: 'text/html' }));
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function apiImage(path: string): Promise<string> {
  const res = await fetch(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return URL.createObjectURL(await res.blob());
}

export async function apiText(path: string): Promise<string> {
  const res = await fetch(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}
