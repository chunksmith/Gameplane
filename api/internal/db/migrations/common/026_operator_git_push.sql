INSERT INTO role_permissions(role_name, permission) VALUES
    ('operator', 'servers:push'),
    ('operator', 'repositories:read'),
    ('operator', 'repositories:write'),
    ('operator', 'repositories:push')
ON CONFLICT (role_name, permission) DO NOTHING;
