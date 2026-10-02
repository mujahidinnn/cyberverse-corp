-- Rekomendasi perbaikan untuk goal yang gagal: diagnosis bahasa awam + pilihan perintah siap kirim (JSON).
ALTER TABLE goals ADD COLUMN recovery_json TEXT;
INSERT INTO schema_migrations (version) VALUES (13);
