INSERT INTO role_permissions(role_name, permission) VALUES ('operator', 'repositories:create') ON CONFLICT (role_name, permission) DO NOTHING;
ALTER TABLE ai_conversations ADD COLUMN repository TEXT NOT NULL DEFAULT '';
