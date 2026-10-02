UPDATE agents SET role = 'Security Gate Keeper (Satpam)' WHERE agent_id = 'agent_goro';
UPDATE agents SET role = 'Onboarding Assistant (Resepsionis)' WHERE agent_id = 'agent_chie';
INSERT INTO schema_migrations (version) VALUES (5);
