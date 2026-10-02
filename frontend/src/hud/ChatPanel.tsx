import { useEffect, useRef, useState } from 'react';
import { useOffice, type ChatMessage } from '../store/officeStore';
import { send } from '../net/wsClient';
import { api } from '../net/api';
import { Icon, Loading } from './icons';
import { Portrait } from './Portrait';

export function ChatPanel() {
  const agentId = useOffice((s) => s.chatWith);
  const agent = useOffice((s) => (s.chatWith ? s.agents[s.chatWith] : undefined));
  const messages = useOffice((s) => (s.chatWith ? s.chats[s.chatWith] : undefined));
  const { setChat, addChat, openChat } = useOffice.getState();
  const [text, setText] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!agentId) return;
    setNotice('');
    setLoading(true);
    api<ChatMessage[]>(`/agents/${agentId}/messages`)
      .then((rows) => setChat(agentId, rows))
      .catch((e) => setNotice(`Gagal memuat riwayat: ${e.message}`))
      .finally(() => setLoading(false));
  }, [agentId, setChat]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  if (!agentId || !agent) return null;

  const submit = () => {
    const msg = text.trim();
    if (!msg) return;
    if (!send('USER_CHAT_TO_AGENT', { agent_id: agentId, message: msg })) {
      setNotice('Koneksi sedang tersambung ulang, coba kirim lagi sebentar.');
      return;
    }
    addChat(agentId, { message_id: -Date.now(), speaker_id: 'human', content: msg });
    addChat(agentId, { message_id: -Date.now() - 1, speaker_id: agentId, content: '…', pending: true });
    setText('');
  };

  const makeTask = async (content: string) => {
    try {
      await api('/tasks', {
        method: 'POST',
        body: JSON.stringify({ title: content.slice(0, 90), description: content, assigned_to: agentId, priority: 2 }),
      });
      setNotice(`Task dibuat untuk ${agent.name}.`);
    } catch (e) {
      setNotice(`Gagal membuat task: ${(e as Error).message}`);
    }
  };

  const clearHistory = async () => {
    if (!window.confirm(`Hapus seluruh riwayat chat dengan ${agent.name}?`)) return;
    try {
      await api(`/agents/${agentId}/messages`, { method: 'DELETE' });
      setChat(agentId, []);
    } catch (e) {
      window.alert(`Gagal menghapus: ${(e as Error).message}`);
    }
  };

  return (
    <aside className="chat-panel" role="dialog" aria-label={`Chat dengan ${agent.name}`}>
      <header>
        <div>
          <Portrait agentId={agent.agent_id} size={32} /> <b>{agent.name}</b> <span className="muted">{agent.role}</span>
        </div>
        <span className="goal-btns">
          <button className="ghost small" onClick={clearHistory} disabled={!(messages ?? []).length} title="Hapus riwayat chat" aria-label="Hapus riwayat chat">
            <Icon name="trash" size={14} />
          </button>
          <button className="ghost small" onClick={() => openChat(null)} aria-label="Tutup chat"><Icon name="close" size={14} /></button>
        </span>
      </header>
      <div className="chat-list" ref={listRef}>
        {loading && (messages ?? []).length === 0 && <Loading>Memuat riwayat</Loading>}
        {!loading && (messages ?? []).length === 0 && <p className="muted">Belum ada percakapan. Sapa {agent.name}!</p>}
        {(messages ?? []).map((m) => (
          <div key={m.message_id} className={`chat-msg ${m.speaker_id === 'human' ? 'me' : 'them'} ${m.pending ? 'pending' : ''}`}>
            {m.pending ? <span className="typing" role="status" aria-label={`${agent.name} sedang mengetik`}><i /><i /><i /></span> : <p>{m.content}</p>}
            {m.speaker_id === 'human' && (
              <button className="link" onClick={() => makeTask(m.content)}>Jadikan task</button>
            )}
          </div>
        ))}
      </div>
      {notice && <p className="chat-notice">{notice}</p>}
      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={`Tulis pesan untuk ${agent.name}… (Enter kirim, Shift+Enter baris baru)`}
          maxLength={2000}
          rows={2}
          autoFocus
        />
        <button type="submit" disabled={!text.trim()}>Kirim</button>
      </form>
    </aside>
  );
}
