-- Ringkasan laporan hasil goal untuk Supervisor (ditampilkan di modal Laporan Hasil).
ALTER TABLE goals ADD COLUMN summary TEXT;
INSERT INTO schema_migrations (version) VALUES (7);
