CREATE TABLE ai_conversations (
    id TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    title TEXT NOT NULL,
    cluster TEXT NOT NULL,
    namespace TEXT NOT NULL,
    server TEXT NOT NULL,
    model TEXT NOT NULL,
    effort TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT NOT NULL,
    run_id TEXT NOT NULL,
    input_tokens BIGINT NOT NULL,
    output_tokens BIGINT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX idx_ai_conversations_user ON ai_conversations(user_id, server, updated_at);

CREATE TABLE ai_messages (
    conversation_id TEXT NOT NULL,
    seq BIGINT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (conversation_id, seq)
);
