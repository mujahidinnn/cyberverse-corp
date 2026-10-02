-- Lanjutan pekerjaan: goal baru yang meneruskan hasil goal sebelumnya (versi berikutnya, versi lama tetap utuh).
-- Hapus proyek: soft delete. Baris goal dan task tetap ada demi jejak audit (approval bersifat append-only),
-- tetapi tidak lagi tampil; file hasil di workspace dihapus sungguhan.
ALTER TABLE goals ADD COLUMN parent_goal_id TEXT REFERENCES goals(goal_id);
ALTER TABLE goals ADD COLUMN deleted_at TEXT;
INSERT INTO schema_migrations (version) VALUES (11);
