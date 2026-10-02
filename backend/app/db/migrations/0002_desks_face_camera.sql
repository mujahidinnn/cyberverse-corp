-- Agen menghadap kamera isometrik (dari arah +X+Z) agar wajah avatar terlihat.
UPDATE desks SET rotation_y = 180 WHERE division IN ('executive', 'engineering');
UPDATE desks SET rotation_y = -90 WHERE division = 'operations';
INSERT INTO schema_migrations (version) VALUES (2);
