import json
from pathlib import Path
from typing import Any

import aiosqlite

HERE = Path(__file__).parent


def _now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


class Repo:
    def __init__(self, db: aiosqlite.Connection) -> None:
        self.db = db

    @classmethod
    async def open(cls, path: str) -> "Repo":
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        db = await aiosqlite.connect(path)
        db.row_factory = aiosqlite.Row
        await db.execute("PRAGMA foreign_keys = ON")
        cur = await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='agents'")
        if await cur.fetchone() is None:
            await db.executescript((HERE / "schema.sql").read_text())
            await db.executescript("BEGIN;" + (HERE / "seed.sql").read_text() + "COMMIT;")
        await cls._migrate(db)
        repo = cls(db)
        await repo._recover_after_restart()
        return repo

    @staticmethod
    async def _migrate(db: aiosqlite.Connection) -> None:
        """Terapkan migrations/NNNN_*.sql yang versinya > versi DB (PRD §15.6)."""
        for old, new in (("number BETWEEN 1 AND 50", "number BETWEEN 1 AND 999"),
                         ("desk_id         TEXT NOT NULL UNIQUE", "desk_id         TEXT UNIQUE")):
            cur = await db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='agents'")
            if old in (await cur.fetchone())[0]:
                version = (await (await db.execute("PRAGMA schema_version")).fetchone())[0]
                await db.execute("PRAGMA writable_schema=ON")
                await db.execute("UPDATE sqlite_master SET sql=replace(sql, ?, ?) WHERE type='table' AND name='agents'",
                                 (old, new))
                await db.execute(f"PRAGMA schema_version={version + 1}")
                await db.execute("PRAGMA writable_schema=OFF")
                await db.commit()
        cur = await db.execute("SELECT COALESCE(max(version), 0) FROM schema_migrations")
        current = (await cur.fetchone())[0]
        for f in sorted((HERE / "migrations").glob("*.sql")):
            if int(f.name.split("_", 1)[0]) > current:
                await db.executescript("BEGIN;" + f.read_text() + "COMMIT;")

    async def close(self) -> None:
        await self.db.close()

    async def _recover_after_restart(self) -> None:
        """PRD §13.10: task yang sedang jalan diulang, approval pending kedaluwarsa."""
        await self.db.execute(
            "UPDATE approval_requests SET status='EXPIRED', decided_by='system', decided_at=? WHERE status='PENDING'",
            (_now(),),
        )
        await self.db.execute(
            "UPDATE tasks SET status='TODO' WHERE status IN ('IN_PROGRESS','REVIEW','WAITING_APPROVAL','MEDIATION')"
        )
        await self.db.execute("UPDATE agents SET status='IDLE', current_task_id=NULL, emotion_icon=NULL "
                              "WHERE status <> 'OFFLINE'")
        await self.db.execute("DELETE FROM event_log WHERE id <= (SELECT max(id) FROM event_log) - 5000")
        await self.db.commit()

    async def log_event(self, event: str, ts: int, payload: dict[str, Any]) -> None:
        await self.db.execute("INSERT INTO event_log (ts, event, payload_json) VALUES (?,?,?)",
                              (ts, event, json.dumps(payload, ensure_ascii=False, default=str)))
        await self.db.commit()

    async def recent_events(self, limit: int) -> list[dict[str, Any]]:
        rows = await self._all("SELECT ts, event, payload_json FROM event_log ORDER BY id DESC LIMIT ?", (limit,))
        return [{"event": r["event"], "ts": r["ts"], "payload": json.loads(r["payload_json"])} for r in reversed(rows)]

    async def _all(self, sql: str, params: tuple = ()) -> list[dict[str, Any]]:
        cur = await self.db.execute(sql, params)
        return [dict(r) for r in await cur.fetchall()]

    async def _one(self, sql: str, params: tuple = ()) -> dict[str, Any] | None:
        cur = await self.db.execute(sql, params)
        row = await cur.fetchone()
        return dict(row) if row else None

    async def list_agents(self) -> list[dict[str, Any]]:
        return await self._all(
            "SELECT a.*, d.x, d.z, d.rotation_y, a.agent_id IN (SELECT agent_id FROM hires) AS hired "
            "FROM agents a JOIN desks d USING (desk_id) ORDER BY a.number"
        )

    async def free_desk(self, division: str) -> str | None:
        row = await self._one("SELECT desk_id FROM desks WHERE division=? AND desk_id NOT IN (SELECT desk_id FROM agents "
                              "WHERE desk_id IS NOT NULL) "
                              "ORDER BY desk_id LIMIT 1", (division,))
        return row["desk_id"] if row else None

    async def hire_counts(self, goal_id: str | None) -> tuple[int, int]:
        """(total rekrutmen, rekrutmen untuk goal ini)."""
        row = await self._one("SELECT count(*) AS total, coalesce(sum(goal_id IS ?), 0) AS here FROM hires "
                              "JOIN agents USING (agent_id) WHERE fired_at IS NULL", (goal_id,))
        return row["total"], row["here"]

    async def hire_agent(self, profile: dict[str, Any], goal_id: str | None, reason: str, approved_by: str) -> dict[str, Any]:
        """Tambah karyawan baru (agen + catatan rekrutmen) secara atomik; return baris agen beserta posisi meja."""
        await self.db.execute(
            "INSERT INTO agents (agent_id, number, name, division, role, tier, kind, desk_id, reports_to) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            tuple(profile[k] for k in ("agent_id", "number", "name", "division", "role", "tier", "kind", "desk_id",
                                       "reports_to")))
        await self.db.execute("INSERT INTO hires (agent_id, goal_id, profile_json, reason, approved_by) VALUES (?,?,?,?,?)",
                              (profile["agent_id"], goal_id, json.dumps(profile, ensure_ascii=False), reason, approved_by))
        await self.db.commit()
        return await self._one("SELECT a.*, d.x, d.z, d.rotation_y FROM agents a JOIN desks d USING (desk_id) "
                               "WHERE a.agent_id=?", (profile["agent_id"],))

    async def hired_profiles(self) -> dict[str, dict[str, Any]]:
        rows = await self._all("SELECT h.agent_id, h.profile_json, a.fired_at FROM hires h JOIN agents a USING (agent_id)")
        return {r["agent_id"]: json.loads(r["profile_json"]) | {"fired": bool(r["fired_at"])} for r in rows}

    async def agent_identities(self) -> list[dict[str, Any]]:
        """Nomor dan nama semua agen, termasuk yang diberhentikan (agar tidak dipakai ulang)."""
        return await self._all("SELECT agent_id, number, name FROM agents")

    async def fire_agent(self, agent_id: str) -> None:
        await self.db.execute("UPDATE agents SET fired_at=?, desk_id=NULL, status='OFFLINE' WHERE agent_id=?",
                              (_now(), agent_id))
        await self.db.commit()

    async def open_task_count(self, agent_id: str) -> int:
        row = await self._one("SELECT count(*) AS n FROM tasks WHERE assigned_to=? AND status NOT IN "
                              "('DONE','FAILED','CANCELLED')", (agent_id,))
        return row["n"]

    async def clear_chat(self, agent_id: str) -> None:
        await self.db.execute("DELETE FROM messages WHERE thread_id=?", (f"chat:{agent_id}",))
        await self.db.commit()

    async def clear_events(self) -> None:
        await self.db.execute("DELETE FROM event_log")
        await self.db.commit()

    async def get_meeting(self, meeting_id: str) -> dict[str, Any] | None:
        return await self._one("SELECT * FROM meetings WHERE meeting_id=?", (meeting_id,))

    async def delete_meeting(self, meeting_id: str) -> None:
        await self.db.execute("DELETE FROM meetings WHERE meeting_id=?", (meeting_id,))
        await self.db.commit()

    async def get_agent(self, agent_id: str) -> dict[str, Any] | None:
        return await self._one("SELECT * FROM agents WHERE agent_id=?", (agent_id,))

    async def set_agent(self, agent_id: str, **fields: Any) -> None:
        allowed = {"status", "emotion_icon", "current_task_id", "last_model"}
        cols = {k: v for k, v in fields.items() if k in allowed}
        if not cols:
            return
        sets = ", ".join(f"{k}=?" for k in cols)
        await self.db.execute(f"UPDATE agents SET {sets}, updated_at=? WHERE agent_id=?",
                              (*cols.values(), _now(), agent_id))
        await self.db.commit()

    async def create_goal(self, goal_id: str, prompt: str, priority: int, review_before_run: bool,
                          parent_goal_id: str | None = None) -> dict:
        await self.db.execute(
            "INSERT INTO goals (goal_id, prompt, priority, review_before_run, parent_goal_id) VALUES (?,?,?,?,?)",
            (goal_id, prompt, priority, int(review_before_run), parent_goal_id),
        )
        await self.db.commit()
        return await self.get_goal(goal_id)

    async def get_goal(self, goal_id: str) -> dict[str, Any] | None:
        return await self._one("SELECT * FROM goals WHERE goal_id=?", (goal_id,))

    async def list_goals(self, limit: int = 50) -> list[dict[str, Any]]:
        return await self._all("SELECT * FROM goals WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ?", (limit,))

    async def goal_lineage(self, goal_id: str) -> list[dict[str, Any]]:
        """Goal ini beserta versi-versi sebelumnya, dari yang paling awal."""
        chain, current = [], await self.get_goal(goal_id)
        while current:
            chain.insert(0, current)
            current = current["parent_goal_id"] and await self.get_goal(current["parent_goal_id"])
        return chain

    async def delete_goal(self, goal_id: str) -> None:
        await self.db.execute("UPDATE goals SET deleted_at=? WHERE goal_id=?", (_now(), goal_id))
        await self.db.commit()

    async def has_live_children(self, goal_id: str) -> bool:
        return await self._one("SELECT 1 FROM goals WHERE parent_goal_id=? AND deleted_at IS NULL LIMIT 1",
                               (goal_id,)) is not None

    async def set_goal(self, goal_id: str, status: str, roadmap: Any = None) -> None:
        finished = _now() if status in ("DONE", "FAILED", "CANCELLED") else None
        await self.db.execute(
            "UPDATE goals SET status=?, roadmap_json=COALESCE(?, roadmap_json), finished_at=COALESCE(?, finished_at) "
            "WHERE goal_id=?",
            (status, json.dumps(roadmap) if roadmap is not None else None, finished, goal_id),
        )
        await self.db.commit()

    async def create_task(self, task: dict[str, Any]) -> dict:
        cols = ", ".join(task)
        marks = ", ".join("?" for _ in task)
        await self.db.execute(f"INSERT INTO tasks ({cols}) VALUES ({marks})", tuple(task.values()))
        await self.db.commit()
        return await self.get_task(task["task_id"])

    async def get_task(self, task_id: str) -> dict[str, Any] | None:
        return await self._one("SELECT * FROM tasks WHERE task_id=?", (task_id,))

    async def list_tasks(self, goal_id: str | None = None) -> list[dict[str, Any]]:
        if goal_id:
            return await self._all("SELECT * FROM tasks WHERE goal_id=? ORDER BY created_at", (goal_id,))
        return await self._all("SELECT * FROM tasks WHERE goal_id IS NULL OR goal_id NOT IN "
                               "(SELECT goal_id FROM goals WHERE deleted_at IS NOT NULL) ORDER BY created_at DESC LIMIT 500")

    async def update_task(self, task_id: str, **fields: Any) -> dict | None:
        allowed = {"status", "priority", "assigned_to", "title", "result_summary", "output_ref", "error",
                   "iteration", "started_at", "finished_at", "cancel_requested"}
        cols = {k: v for k, v in fields.items() if k in allowed}
        if cols:
            sets = ", ".join(f"{k}=?" for k in cols)
            await self.db.execute(f"UPDATE tasks SET {sets} WHERE task_id=?", (*cols.values(), task_id))
            await self.db.commit()
        return await self.get_task(task_id)

    async def set_task_status(self, task_id: str | None, status: str) -> None:
        if task_id:
            await self.update_task(task_id, status=status)

    async def ready_tasks(self, limit: int) -> list[dict[str, Any]]:
        """Query scheduler PRD §15.5."""
        return await self._all(
            """
            SELECT t.* FROM tasks t JOIN agents a ON a.agent_id = t.assigned_to
            WHERE t.status = 'TODO' AND a.status <> 'OFFLINE'
              AND NOT EXISTS (SELECT 1 FROM task_dependencies d JOIN tasks dep ON dep.task_id = d.depends_on_id
                              WHERE d.task_id = t.task_id AND dep.status <> 'DONE')
              AND NOT EXISTS (SELECT 1 FROM tasks busy WHERE busy.assigned_to = t.assigned_to
                              AND busy.status IN ('IN_PROGRESS','REVIEW','WAITING_APPROVAL','MEDIATION'))
            ORDER BY t.priority ASC, t.created_at ASC LIMIT ?
            """,
            (limit,),
        )

    async def blocked_tasks(self, goal_id: str) -> list[dict[str, Any]]:
        """Task belum jalan yang prasyaratnya gagal atau dibatalkan, jadi tidak akan pernah bisa jalan."""
        return await self._all(
            "SELECT t.* FROM tasks t WHERE t.goal_id=? AND t.status IN ('PLANNED','TODO') AND EXISTS ("
            "SELECT 1 FROM task_dependencies d JOIN tasks dep ON dep.task_id = d.depends_on_id "
            "WHERE d.task_id = t.task_id AND dep.status IN ('FAILED','CANCELLED'))", (goal_id,))

    async def drop_dependents(self, task_id: str) -> None:
        """Lepas semua task yang menunggu task ini (prasyarat opsional yang dilewati)."""
        await self.db.execute("DELETE FROM task_dependencies WHERE depends_on_id=?", (task_id,))
        await self.db.commit()

    async def dependency_ids(self, task_id: str) -> list[str]:
        rows = await self._all("SELECT depends_on_id FROM task_dependencies WHERE task_id=?", (task_id,))
        return [r["depends_on_id"] for r in rows]

    async def add_dependency(self, task_id: str, depends_on_id: str) -> None:
        await self.db.execute("INSERT OR IGNORE INTO task_dependencies VALUES (?,?)", (task_id, depends_on_id))
        await self.db.commit()

    async def insert_approval(self, **f: Any) -> None:
        await self.db.execute(
            "INSERT INTO approval_requests (request_id, task_id, agent_id, tool_name, tool_input, risk_level, "
            "escalation_reason, justification, expires_at) VALUES (?,?,?,?,?,'HIGH',?,?,?)",
            (f["request_id"], f["task_id"], f["agent_id"], f["tool_name"], f["tool_input"],
             f["escalation_reason"], f["justification"], f["expires_at"]),
        )
        await self.db.commit()

    async def decide_approval(self, request_id: str, status: str, decided_by: str, reason: str | None) -> None:
        await self.db.execute(
            "UPDATE approval_requests SET status=?, decided_by=?, decision_reason=?, decided_at=? WHERE request_id=?",
            (status, decided_by, reason, _now(), request_id),
        )
        await self.db.commit()

    async def approval_task_id(self, request_id: str) -> str | None:
        row = await self._one("SELECT task_id FROM approval_requests WHERE request_id=?", (request_id,))
        return row["task_id"] if row else None

    async def get_approval(self, request_id: str) -> dict[str, Any] | None:
        return await self._one("SELECT * FROM approval_requests WHERE request_id=?", (request_id,))

    async def list_approvals(self, status: str | None = None) -> list[dict[str, Any]]:
        if status:
            return await self._all("SELECT * FROM approval_requests WHERE status=? ORDER BY created_at", (status,))
        return await self._all("SELECT * FROM approval_requests ORDER BY created_at DESC LIMIT 200")

    async def log_tool(self, **f: Any) -> None:
        await self.db.execute(
            "INSERT INTO tool_executions (task_id, agent_id, tool_name, risk_level, request_id, input_json, "
            "output_text, status, duration_ms) VALUES (?,?,?,?,?,?,?,?,?)",
            (f["task_id"], f["agent_id"], f["tool_name"], f["risk_level"], f["request_id"], f["input_json"],
             f["output_text"], f["status"], f["duration_ms"]),
        )
        await self.db.commit()

    async def log_llm_usage(self, **f: Any) -> None:
        await self.db.execute(
            "INSERT INTO llm_usage (agent_id, task_id, tier, model, prompt_tokens, completion_tokens, latency_ms, "
            "status, failover_from) VALUES (?,?,?,?,?,?,?,?,?)",
            (f["agent_id"], f.get("task_id"), f["tier"], f["model"], f.get("prompt_tokens", 0),
             f.get("completion_tokens", 0), f.get("latency_ms"), f["status"], f.get("failover_from")),
        )
        await self.db.commit()

    async def task_load(self) -> dict[str, int]:
        rows = await self._all("SELECT assigned_to, count(*) AS n FROM tasks "
                               "WHERE status IN ('PLANNED','TODO','IN_PROGRESS','WAITING_APPROVAL') GROUP BY assigned_to")
        return {r["assigned_to"]: r["n"] for r in rows}

    async def add_message(self, thread_id: str, speaker_id: str, listener_id: str | None, role: str, content: str,
                          bubble_style: str | None = None) -> int:
        cur = await self.db.execute(
            "INSERT INTO messages (thread_id, speaker_id, listener_id, role, content, bubble_style) VALUES (?,?,?,?,?,?)",
            (thread_id, speaker_id, listener_id, role, content, bubble_style),
        )
        await self.db.commit()
        return cur.lastrowid

    async def recent_messages(self, thread_id: str, limit: int = 10) -> list[dict[str, Any]]:
        rows = await self._all("SELECT * FROM messages WHERE thread_id=? ORDER BY message_id DESC LIMIT ?",
                               (thread_id, limit))
        return rows[::-1]

    async def active_rules(self, division: str) -> list[str]:
        rows = await self._all("SELECT content FROM user_rules WHERE active=1 AND division IN ('global', ?) "
                               "ORDER BY rule_id DESC LIMIT 5", (division,))
        return [r["content"] for r in rows]

    async def list_rules(self) -> list[dict[str, Any]]:
        return await self._all("SELECT * FROM user_rules WHERE active=1 ORDER BY rule_id DESC")

    async def add_rule(self, content: str, division: str) -> dict[str, Any]:
        cur = await self.db.execute("INSERT INTO user_rules (content, division) VALUES (?,?)", (content, division))
        await self.db.commit()
        return await self._one("SELECT * FROM user_rules WHERE rule_id=?", (cur.lastrowid,))

    async def deactivate_rule(self, rule_id: int) -> bool:
        cur = await self.db.execute("UPDATE user_rules SET active=0 WHERE rule_id=? AND active=1", (rule_id,))
        await self.db.commit()
        return cur.rowcount > 0

    async def recent_activity(self, division: str, agent_id: str, limit: int = 5) -> list[dict[str, Any]]:
        return await self._all(
            "SELECT title, assigned_to, reviewer_id, status, iteration, output_ref, "
            "COALESCE(finished_at, started_at, created_at) AS at FROM tasks "
            "WHERE division=? OR assigned_to=? OR reviewer_id=? ORDER BY at DESC LIMIT ?",
            (division, agent_id, agent_id, limit),
        )

    async def create_meeting(self, meeting_id: str, type_: str, agenda: list[str], goal_id: str | None = None) -> None:
        await self.db.execute(
            "INSERT INTO meetings (meeting_id, type, goal_id, status, agenda_json, scheduled_at, started_at) "
            "VALUES (?,?,?,?,?,?,?)",
            (meeting_id, type_, goal_id, "RUNNING", json.dumps(agenda, ensure_ascii=False), _now(), _now()),
        )
        await self.db.commit()

    async def add_participant(self, meeting_id: str, agent_id: str, slot_id: str | None, remote: bool) -> None:
        await self.db.execute("INSERT INTO meeting_participants VALUES (?,?,?,?)",
                              (meeting_id, agent_id, slot_id, int(remote)))
        await self.db.commit()

    async def finish_meeting(self, meeting_id: str, minutes: str, status: str = "DONE") -> None:
        await self.db.execute("UPDATE meetings SET status=?, minutes=?, ended_at=? WHERE meeting_id=?",
                              (status, minutes, _now(), meeting_id))
        await self.db.commit()

    async def running_meeting(self) -> dict[str, Any] | None:
        return await self._one("SELECT * FROM meetings WHERE status='RUNNING' AND type='ALL_HANDS' LIMIT 1")

    async def goal_kickoff(self, goal_id: str) -> str | None:
        """Notulen rapat kickoff goal (kesepakatan sebelum eksekusi)."""
        row = await self._one("SELECT minutes FROM meetings WHERE goal_id=? AND type='LEADS' AND status='DONE' "
                              "ORDER BY scheduled_at DESC LIMIT 1", (goal_id,))
        return row["minutes"] if row else None

    async def list_meetings(self, limit: int = 20) -> list[dict[str, Any]]:
        return await self._all("SELECT * FROM meetings ORDER BY scheduled_at DESC LIMIT ?", (limit,))

    async def progress_summary(self) -> dict[str, Any]:
        goals = await self._all("SELECT status, count(*) AS n FROM goals GROUP BY status")
        tasks = await self._all("SELECT status, count(*) AS n FROM tasks GROUP BY status")
        return {"goals": {r["status"]: r["n"] for r in goals}, "tasks": {r["status"]: r["n"] for r in tasks}}

    async def stuck_tasks(self, minutes: int) -> list[dict[str, Any]]:
        return await self._all(
            "SELECT task_id, title, assigned_to, started_at FROM tasks WHERE status='IN_PROGRESS' "
            "AND started_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)", (f"-{minutes} minutes",))

    async def cleanup_counts(self, log_days: int, message_days: int) -> dict[str, int]:
        q = {
            "llm_usage": f"SELECT count(*) FROM llm_usage WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-{log_days} days')",
            "tool_executions": f"SELECT count(*) FROM tool_executions WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-{log_days} days')",
            "messages": "SELECT count(*) FROM messages m WHERE m.thread_id LIKE 'task:%' AND EXISTS (SELECT 1 FROM tasks t "
                        "JOIN goals g ON g.goal_id = t.goal_id WHERE 'task:' || t.task_id = m.thread_id AND g.finished_at < "
                        f"strftime('%Y-%m-%dT%H:%M:%fZ','now','-{message_days} days'))",
        }
        out = {}
        for k, sql in q.items():
            cur = await self.db.execute(sql)
            out[k] = (await cur.fetchone())[0]
        return out

    async def cleanup(self, log_days: int, message_days: int) -> None:
        cutoff = f"strftime('%Y-%m-%dT%H:%M:%fZ','now','-{log_days} days')"
        await self.db.execute(f"DELETE FROM llm_usage WHERE created_at < {cutoff}")
        await self.db.execute(f"DELETE FROM tool_executions WHERE created_at < {cutoff} AND request_id IS NULL")
        await self.db.execute(
            "DELETE FROM messages WHERE thread_id LIKE 'task:%' AND thread_id IN (SELECT 'task:' || t.task_id FROM tasks t "
            "JOIN goals g ON g.goal_id = t.goal_id WHERE g.finished_at < "
            f"strftime('%Y-%m-%dT%H:%M:%fZ','now','-{message_days} days'))")
        await self.db.commit()
        await self.db.execute("VACUUM")

    async def set_goal_recovery(self, goal_id: str, recovery: dict) -> None:
        await self.db.execute("UPDATE goals SET recovery_json=? WHERE goal_id=?",
                              (json.dumps(recovery, ensure_ascii=False), goal_id))
        await self.db.commit()

    async def set_goal_report(self, goal_id: str, path: str | None, summary: str) -> None:
        await self.db.execute("UPDATE goals SET report_path=?, summary=? WHERE goal_id=?", (path, summary, goal_id))
        await self.db.commit()

    async def finish_goal_once(self, goal_id: str, status: str) -> bool:
        """Atomik: hanya satu pemanggil yang berhasil memindahkan goal RUNNING → status akhir."""
        cur = await self.db.execute("UPDATE goals SET status=?, finished_at=? WHERE goal_id=? AND status='RUNNING'",
                                    (status, _now(), goal_id))
        await self.db.commit()
        return cur.rowcount == 1
