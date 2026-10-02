-- Pemberhentian karyawan rekrutan: barisnya tetap (riwayat task & audit approval merujuk ke sana), mejanya dilepas.
-- desk_id boleh NULL dilonggarkan oleh Repo._migrate (SQLite tidak bisa ALTER NOT NULL).
ALTER TABLE agents ADD COLUMN fired_at TEXT;
INSERT INTO schema_migrations (version) VALUES (12);
