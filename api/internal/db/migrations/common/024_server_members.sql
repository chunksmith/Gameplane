CREATE TABLE server_members (
    user_id BIGINT NOT NULL,
    cluster TEXT NOT NULL,
    namespace TEXT NOT NULL,
    server TEXT NOT NULL,
    server_uid TEXT NOT NULL DEFAULT '',
    permissions TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (user_id, cluster, namespace, server)
);
CREATE INDEX idx_server_members_server ON server_members(cluster, namespace, server);
