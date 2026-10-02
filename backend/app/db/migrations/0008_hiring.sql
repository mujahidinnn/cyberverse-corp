-- Rekrutmen: meja cadangan per divisi (kosong sampai ada karyawan baru) dan catatan rekrutmen.
-- Batas nomor agen (CHECK 1..50) dilonggarkan oleh Repo._migrate karena SQLite tidak bisa ALTER CHECK.
INSERT INTO desks (desk_id, division, x, z, rotation_y) VALUES
  ('desk_eng_13', 'engineering', -16.5, -11.0, 180), ('desk_eng_14', 'engineering', -13.5, -11.0, 180),
  ('desk_eng_15', 'engineering', -10.5, -11.0, 180), ('desk_eng_16', 'engineering', 10.5, -11.0, 180),
  ('desk_eng_17', 'engineering', 13.5, -11.0, 180),  ('desk_eng_18', 'engineering', 16.5, -11.0, 180),
  ('desk_cre_13', 'creative', 22.0, 10.5, -90),      ('desk_cre_14', 'creative', 26.0, 10.5, -90),
  ('desk_mkt_12', 'marketing', -15.0, 19.0, 180),    ('desk_mkt_13', 'marketing', -12.0, 19.0, 180),
  ('desk_mkt_14', 'marketing', -9.0, 19.0, 180),     ('desk_mkt_15', 'marketing', -6.0, 19.0, 180),
  ('desk_ops_13', 'operations', -26.0, -4.5, -90),   ('desk_ops_14', 'operations', -26.0, -1.5, -90),
  ('desk_ops_15', 'operations', -22.0, 10.5, -90),   ('desk_ops_16', 'operations', -26.0, 10.5, -90);

CREATE TABLE hires (
    agent_id     TEXT PRIMARY KEY REFERENCES agents(agent_id),
    goal_id      TEXT REFERENCES goals(goal_id),
    profile_json TEXT NOT NULL,              -- profil lengkap (persona, skill, tier) seperti entri agents.yaml
    reason       TEXT NOT NULL,
    approved_by  TEXT NOT NULL CHECK (approved_by IN ('hrd','human')),
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO schema_migrations (version) VALUES (8);
