-- Tim Konten & Media Sosial: sebelas karyawan tetap baru (nomor 60-70) di Marketing dan Creative, plus mejanya.
-- Meja cadangan rekrutmen (desk_mkt_14/15, desk_cre_15/16) tetap kosong.
INSERT INTO desks (desk_id, division, x, z, rotation_y) VALUES
  ('desk_mkt_16', 'marketing', -3.0, 19.0, 180), ('desk_mkt_17', 'marketing', 0.0, 19.0, 180),
  ('desk_mkt_18', 'marketing', 3.0, 19.0, 180),  ('desk_mkt_19', 'marketing', 6.0, 19.0, 180),
  ('desk_mkt_20', 'marketing', 9.0, 19.0, 180),  ('desk_mkt_21', 'marketing', 12.0, 19.0, 180),
  ('desk_cre_17', 'creative', 22.0, 16.5, -90),  ('desk_cre_18', 'creative', 26.0, 16.5, -90),
  ('desk_cre_19', 'creative', 22.0, 19.5, -90),  ('desk_cre_20', 'creative', 26.0, 19.5, -90),
  ('desk_cre_21', 'creative', 22.0, 22.5, -90);

INSERT INTO agents (agent_id, number, name, division, role, tier, kind, desk_id, reports_to) VALUES
  ('agent_kanade',  60, 'Kanade',  'marketing', 'Head of Content & Social Media',      'T3_DOC',         'llm', 'desk_mkt_16', 'agent_ryota'),
  ('agent_hayate',  61, 'Hayate',  'marketing', 'Virality & FYP Specialist',           'T2_FAST',        'llm', 'desk_mkt_17', 'agent_kanade'),
  ('agent_shizuka', 62, 'Shizuka', 'marketing', 'Content Strategist',                  'T3_DOC',         'llm', 'desk_mkt_18', 'agent_kanade'),
  ('agent_mitsuki', 63, 'Mitsuki', 'marketing', 'Content Planner',                     'T3_DOC',         'llm', 'desk_mkt_19', 'agent_kanade'),
  ('agent_ibuki',   64, 'Ibuki',   'marketing', 'Content Repurposing Specialist',      'T2_FAST',        'llm', 'desk_mkt_20', 'agent_kanade'),
  ('agent_satoru',  65, 'Satoru',  'marketing', 'Social Media Analyst',                'T3_DOC',         'llm', 'desk_mkt_21', 'agent_kanade'),
  ('agent_natsu',   66, 'Natsu',   'creative',  'Hook Specialist',                     'T2_FAST',        'llm', 'desk_cre_17', 'agent_luna'),
  ('agent_gaku',    67, 'Gaku',    'creative',  'Meme & Culture Specialist',           'T2_FAST',        'llm', 'desk_cre_18', 'agent_luna'),
  ('agent_kyo',     68, 'Kyo',     'creative',  'Multimedia Editing Brief Specialist', 'T3_DOC',         'llm', 'desk_cre_19', 'agent_luna'),
  ('agent_sakura',  69, 'Sakura',  'creative',  'Localization Specialist',             'T5_LOCAL_LIGHT', 'llm', 'desk_cre_20', 'agent_luna'),
  ('agent_misaki',  70, 'Misaki',  'creative',  'Digital Asset & Rights Manager',      'T5_LOCAL_LIGHT', 'llm', 'desk_cre_21', 'agent_luna');
INSERT INTO schema_migrations (version) VALUES (10);
