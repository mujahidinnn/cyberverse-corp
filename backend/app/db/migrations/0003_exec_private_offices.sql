-- C-level mendapat kantor kaca pribadi (Executive Wing); meja dipindah ke tengah tiap kantor.
UPDATE desks SET x = -4.5, z = -4.2 WHERE desk_id = 'desk_exec_01';
UPDATE desks SET x = 0,    z = -4.2 WHERE desk_id = 'desk_exec_02';
UPDATE desks SET x = 4.5,  z = -4.2 WHERE desk_id = 'desk_exec_03';
INSERT INTO schema_migrations (version) VALUES (3);
