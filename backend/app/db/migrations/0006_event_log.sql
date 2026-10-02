-- Riwayat kejadian untuk Log Live, agar log tetap ada setelah browser ditutup atau backend dinyalakan ulang.
CREATE TABLE event_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           INTEGER NOT NULL,
    event        TEXT NOT NULL,
    payload_json TEXT NOT NULL
);
INSERT INTO schema_migrations (version) VALUES (6);
