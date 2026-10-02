-- Sayap timur: Goro (Security Gate Keeper) jaga pos satpam di pintu masuk, Chie (Onboarding) jadi resepsionis lobby.
UPDATE desks SET x = 46.5, z = 21.2, rotation_y = 180 WHERE desk_id = 'desk_ops_08';
UPDATE desks SET x = 37.2, z = 12.0, rotation_y = -90 WHERE desk_id = 'desk_ops_09';
INSERT INTO schema_migrations (version) VALUES (4);
