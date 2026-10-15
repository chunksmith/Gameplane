CREATE TABLE networks (
    name TEXT PRIMARY KEY
);

CREATE TABLE network_members (
    network_name TEXT NOT NULL,
    user_id BIGINT NOT NULL,
    PRIMARY KEY (network_name, user_id)
);

CREATE INDEX idx_network_members_user ON network_members(user_id);

INSERT INTO roles(name, description, builtin) VALUES
    ('member', 'No panel-wide access; sees only owned, shared and network servers.', 1)
    ON CONFLICT (name) DO NOTHING;
