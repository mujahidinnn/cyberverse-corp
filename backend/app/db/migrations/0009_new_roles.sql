-- Sembilan karyawan tetap baru (nomor 51-59) untuk peran yang belum ada, plus dua meja cadangan Creative.
INSERT INTO desks (desk_id, division, x, z, rotation_y) VALUES
  ('desk_cre_15', 'creative', 22.0, 13.5, -90), ('desk_cre_16', 'creative', 26.0, 13.5, -90);

INSERT INTO agents (agent_id, number, name, division, role, tier, kind, desk_id, reports_to) VALUES
  ('agent_sena',   51, 'Sena',   'operations',  'HR Manager (HRD)',         'T2_FAST',       'llm', 'desk_ops_13', 'agent_daichi'),
  ('agent_tetsu',  52, 'Tetsu',  'operations',  'Finance & Budget Officer', 'T3_DOC',        'llm', 'desk_ops_14', 'agent_daichi'),
  ('agent_ayame',  53, 'Ayame',  'operations',  'Legal & Compliance',       'T3_DOC',        'llm', 'desk_ops_15', 'agent_daichi'),
  ('agent_jiro',   54, 'Jiro',   'engineering', 'Data Analyst',             'T4_LOCAL_CODE', 'llm', 'desk_eng_13', 'agent_aoi'),
  ('agent_momo',   55, 'Momo',   'engineering', 'Web Developer',            'T4_LOCAL_CODE', 'llm', 'desk_eng_14', 'agent_aoi'),
  ('agent_kei',    56, 'Kei',    'creative',    'Graphic Designer',         'T3_DOC',        'llm', 'desk_cre_13', 'agent_luna'),
  ('agent_hotaru', 57, 'Hotaru', 'creative',    'Content Writer',           'T3_DOC',        'llm', 'desk_cre_14', 'agent_luna'),
  ('agent_ryo',    58, 'Ryo',    'marketing',   'Business Development',     'T2_FAST',       'llm', 'desk_mkt_12', 'agent_ryota'),
  ('agent_sumire', 59, 'Sumire', 'marketing',   'Customer Support',         'T2_FAST',       'llm', 'desk_mkt_13', 'agent_ryota');
INSERT INTO schema_migrations (version) VALUES (9);
