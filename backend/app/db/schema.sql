PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- 1. Meja (layout statis, di-seed dari §6.3)
CREATE TABLE desks (
    desk_id      TEXT PRIMARY KEY,
    division     TEXT NOT NULL CHECK (division IN ('executive','engineering','creative','marketing','operations')),
    x            REAL NOT NULL,
    z            REAL NOT NULL,
    rotation_y   INTEGER NOT NULL DEFAULT 0
);

-- 2. Agen (master + status runtime)
CREATE TABLE agents (
    agent_id        TEXT PRIMARY KEY,
    number          INTEGER NOT NULL UNIQUE CHECK (number BETWEEN 1 AND 999),
    name            TEXT NOT NULL,
    division        TEXT NOT NULL CHECK (division IN ('executive','engineering','creative','marketing','operations')),
    role            TEXT NOT NULL,
    tier            TEXT NOT NULL CHECK (tier IN ('T1_REASON','T2_FAST','T3_DOC','T4_LOCAL_CODE','T5_LOCAL_LIGHT')),
    kind            TEXT NOT NULL DEFAULT 'llm' CHECK (kind IN ('llm','system')),
    desk_id         TEXT UNIQUE REFERENCES desks(desk_id),  -- NULL = sudah diberhentikan
    reports_to      TEXT REFERENCES agents(agent_id) DEFERRABLE INITIALLY DEFERRED,
    status          TEXT NOT NULL DEFAULT 'IDLE' CHECK (status IN
                    ('IDLE','MOVING','THINKING','QUEUED','WORKING','WAITING_APPROVAL','TALKING','MEETING','ERROR','OFFLINE')),
    current_task_id TEXT,
    emotion_icon    TEXT,
    last_model      TEXT,
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 3. Goal dari Supervisor
CREATE TABLE goals (
    goal_id           TEXT PRIMARY KEY,
    prompt            TEXT NOT NULL CHECK (length(prompt) BETWEEN 10 AND 4000),
    divisions         TEXT NOT NULL DEFAULT '["engineering","creative","marketing","operations"]', -- JSON array
    review_before_run INTEGER NOT NULL DEFAULT 1 CHECK (review_before_run IN (0,1)),
    priority          INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),
    status            TEXT NOT NULL DEFAULT 'PLANNING' CHECK (status IN
                      ('PLANNING','AWAITING_START','RUNNING','DONE','FAILED','CANCELLED')),
    roadmap_json      TEXT,             -- Roadmap (Pydantic) hasil Ren
    report_path       TEXT,             -- REPORT-<goal_id>.md (Shiori)
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    finished_at       TEXT
);

-- 4. Task
CREATE TABLE tasks (
    task_id          TEXT PRIMARY KEY,
    goal_id          TEXT REFERENCES goals(goal_id) ON DELETE CASCADE,  -- NULL = task dari chat CEO
    parent_task_id   TEXT REFERENCES tasks(task_id),
    epic_key         TEXT,
    title            TEXT NOT NULL CHECK (length(title) <= 100),
    description      TEXT,
    division         TEXT NOT NULL,
    required_skills  TEXT NOT NULL DEFAULT '[]',   -- JSON array
    acceptance_json  TEXT NOT NULL DEFAULT '[]',   -- JSON array acceptance criteria
    assigned_to      TEXT REFERENCES agents(agent_id),
    reviewer_id      TEXT REFERENCES agents(agent_id),
    created_by       TEXT NOT NULL,                -- agent_id atau 'human'
    status           TEXT NOT NULL DEFAULT 'TODO' CHECK (status IN
                     ('PLANNED','TODO','IN_PROGRESS','WAITING_APPROVAL','REVIEW','MEDIATION','DONE','FAILED','CANCELLED')),
    priority         INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),
    iteration        INTEGER NOT NULL DEFAULT 0,
    max_iterations   INTEGER NOT NULL DEFAULT 5,
    cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1)),
    handoff_line     TEXT,
    result_summary   TEXT,
    output_ref       TEXT,                         -- path artefak di workspace
    error            TEXT,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    started_at       TEXT,
    finished_at      TEXT
);
CREATE INDEX idx_tasks_status_priority ON tasks(status, priority, created_at);
CREATE INDEX idx_tasks_goal ON tasks(goal_id);
CREATE INDEX idx_tasks_assignee_status ON tasks(assigned_to, status);

-- 5. Dependensi antar-task
CREATE TABLE task_dependencies (
    task_id        TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    depends_on_id  TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, depends_on_id),
    CHECK (task_id <> depends_on_id)
);

-- 6. Pesan (short-term memory + riwayat dialog)
CREATE TABLE messages (
    message_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id    TEXT NOT NULL,                    -- 'task:<task_id>' | 'chat:<agent_id>' | 'meeting:<meeting_id>'
    speaker_id   TEXT NOT NULL,                    -- agent_id | 'human' | 'system'
    listener_id  TEXT,
    role         TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
    content      TEXT NOT NULL,
    bubble_style TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_messages_thread ON messages(thread_id, message_id DESC);

-- 7. Approval Gate (audit trail permanen)
CREATE TABLE approval_requests (
    request_id       TEXT PRIMARY KEY,
    task_id          TEXT REFERENCES tasks(task_id),
    agent_id         TEXT NOT NULL REFERENCES agents(agent_id),
    tool_name        TEXT NOT NULL,
    tool_input       TEXT NOT NULL,                -- input mentah (JSON)
    risk_level       TEXT NOT NULL CHECK (risk_level IN ('HIGH')),
    escalation_reason TEXT,                        -- mis. 'SQL mengandung DELETE'
    justification    TEXT,                         -- alasan dari agen
    explanation      TEXT,                         -- ringkasan awam dari Goro
    status           TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN
                     ('PENDING','APPROVED','REJECTED','EXPIRED','CANCELLED')),
    decision_reason  TEXT,
    decided_by       TEXT,                         -- 'human' | 'system'
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    expires_at       TEXT NOT NULL,
    decided_at       TEXT,
    execution_status TEXT CHECK (execution_status IN ('SUCCEEDED','FAILED')),
    execution_output TEXT                          -- dipotong 20 KB
);
CREATE INDEX idx_approvals_status ON approval_requests(status, created_at);

-- Audit trail tidak bisa dihapus / keputusan tidak bisa diubah setelah final
CREATE TRIGGER trg_approvals_no_delete BEFORE DELETE ON approval_requests
BEGIN
    SELECT RAISE(ABORT, 'approval_requests is append-only');
END;
CREATE TRIGGER trg_approvals_final BEFORE UPDATE OF status ON approval_requests
WHEN OLD.status <> 'PENDING'
BEGIN
    SELECT RAISE(ABORT, 'approval decision is final');
END;

-- 8. Log eksekusi tool (semua level)
CREATE TABLE tool_executions (
    execution_id  INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id       TEXT REFERENCES tasks(task_id),
    agent_id      TEXT NOT NULL REFERENCES agents(agent_id),
    tool_name     TEXT NOT NULL,
    risk_level    TEXT NOT NULL CHECK (risk_level IN ('LOW','MEDIUM','HIGH','FORBIDDEN')),
    request_id    TEXT REFERENCES approval_requests(request_id),
    input_json    TEXT NOT NULL,
    output_text   TEXT,
    status        TEXT NOT NULL CHECK (status IN ('SUCCEEDED','FAILED','DENIED','REJECTED')),
    duration_ms   INTEGER,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_tool_exec_task ON tool_executions(task_id);

-- 9. Pemakaian LLM (kuota & biaya token)
CREATE TABLE llm_usage (
    usage_id          INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id          TEXT REFERENCES agents(agent_id),
    task_id           TEXT,
    tier              TEXT NOT NULL,
    model             TEXT NOT NULL,
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    latency_ms        INTEGER,
    status            TEXT NOT NULL CHECK (status IN ('OK','RATE_LIMITED','ERROR','TIMEOUT')),
    failover_from     TEXT,
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_llm_usage_model_time ON llm_usage(model, created_at);

-- 10. Rapat
CREATE TABLE meetings (
    meeting_id   TEXT PRIMARY KEY,
    type         TEXT NOT NULL CHECK (type IN ('ALL_HANDS','LEADS','MEDIATION')),
    goal_id      TEXT REFERENCES goals(goal_id),
    status       TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED','RUNNING','DONE','CANCELLED')),
    agenda_json  TEXT,
    minutes      TEXT,                              -- notulen Nana
    scheduled_at TEXT NOT NULL,
    started_at   TEXT,
    ended_at     TEXT
);
CREATE TABLE meeting_participants (
    meeting_id TEXT NOT NULL REFERENCES meetings(meeting_id) ON DELETE CASCADE,
    agent_id   TEXT NOT NULL REFERENCES agents(agent_id),
    slot_id    TEXT,                                -- 'seat_03' | 'townhall_27'
    remote     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (meeting_id, agent_id)
);

-- 11. Aturan permanen dari Supervisor
CREATE TABLE user_rules (
    rule_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    content    TEXT NOT NULL CHECK (length(content) <= 500),
    division   TEXT NOT NULL DEFAULT 'global',
    active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 12. Versi skema (migrasi)
CREATE TABLE schema_migrations (
    version    INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO schema_migrations (version) VALUES (1);
