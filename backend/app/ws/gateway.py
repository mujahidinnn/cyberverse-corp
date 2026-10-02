import asyncio
import json
import logging
import time
from collections import deque
from typing import Any, Callable

from fastapi import WebSocket

log = logging.getLogger(__name__)

PROTOCOL_VERSION = 1
RING_SIZE = 1000
CLIENT_QUEUE_MAX = 1000
COALESCE_MS = 100
LOGGED_EVENTS = {"GOAL_UPDATED", "TASK_CREATED", "TASK_UPDATED", "AGENT_DIALOGUE_SPOKEN", "TOOL_EXECUTION_LOG",
                 "APPROVAL_REQUIRED", "APPROVAL_RESOLVED", "SYSTEM_ALERT", "MEETING_STARTED", "MEETING_ENDED", "AGENT_HIRED"}


class Client:
    """Satu koneksi WS dengan antrean kirim sendiri, agar klien lambat tidak menahan klien lain."""

    def __init__(self, ws: WebSocket) -> None:
        self.ws = ws
        self.queue: asyncio.Queue[str] = asyncio.Queue(maxsize=CLIENT_QUEUE_MAX)
        self.sender: asyncio.Task | None = None
        self.last_chat = 0.0

    async def run_sender(self) -> None:
        while True:
            data = await self.queue.get()
            await self.ws.send_text(data)


class EventBus:
    def __init__(self) -> None:
        self.clients: set[Client] = set()
        self.seq = int(time.time() * 1000)
        self.ring: deque[tuple[int, str]] = deque(maxlen=RING_SIZE)
        self._pending_states: dict[str, dict[str, Any]] = {}
        self._flusher: asyncio.Task | None = None
        self.sink: Callable[[str, int, dict[str, Any]], None] | None = None

    def add(self, client: Client) -> None:
        client.sender = asyncio.create_task(client.run_sender())
        self.clients.add(client)

    def remove(self, client: Client) -> None:
        self.clients.discard(client)
        if client.sender:
            client.sender.cancel()

    def replay_since(self, last_seq: int) -> list[str] | None:
        """Event setelah last_seq, atau None jika sudah keluar dari ring buffer."""
        if not self.ring or last_seq < self.ring[0][0] - 1 or last_seq > self.seq:
            return None
        return [data for seq, data in self.ring if seq > last_seq]

    def publish(self, event: str, payload: dict[str, Any]) -> None:
        self.seq += 1
        ts = int(time.time() * 1000)
        data = json.dumps(
            {"v": PROTOCOL_VERSION, "event": event, "seq": self.seq, "ts": ts, "payload": payload},
            ensure_ascii=False,
        )
        if self.sink and event in LOGGED_EVENTS:
            self.sink(event, ts, payload)
        self.ring.append((self.seq, data))
        for client in list(self.clients):
            try:
                client.queue.put_nowait(data)
            except asyncio.QueueFull:
                log.warning("client queue full, dropping connection")
                self.remove(client)
                asyncio.create_task(client.ws.close(code=1013))

    def publish_agent_state(self, agent_id: str, **fields: Any) -> None:
        """Gabungkan update beruntun untuk agen yang sama dalam jendela COALESCE_MS."""
        self._pending_states.setdefault(agent_id, {"agent_id": agent_id}).update(fields)
        if self._flusher is None or self._flusher.done():
            self._flusher = asyncio.create_task(self._flush_states())

    async def _flush_states(self) -> None:
        await asyncio.sleep(COALESCE_MS / 1000)
        pending, self._pending_states = self._pending_states, {}
        for payload in pending.values():
            self.publish("AGENT_STATE_UPDATE", payload)


bus = EventBus()
