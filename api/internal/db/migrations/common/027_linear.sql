ALTER TABLE ai_conversations ADD COLUMN linear_issue TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_ai_conversations_linear ON ai_conversations(user_id, linear_issue);
CREATE TABLE linear_repo_links (
    user_id BIGINT NOT NULL,
    project_id TEXT NOT NULL,
    project_name TEXT NOT NULL,
    repository TEXT NOT NULL,
    namespace TEXT NOT NULL,
    PRIMARY KEY (user_id, project_id)
);
