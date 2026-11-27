package db

import (
	"context"
	"fmt"
)

type LinearLink struct {
	ProjectID   string `json:"projectId"`
	ProjectName string `json:"projectName"`
	Repository  string `json:"repository"`
	Namespace   string `json:"namespace"`
}

func (s *Store) LinearLinks(ctx context.Context, userID int64) ([]LinearLink, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT project_id, project_name, repository, namespace FROM linear_repo_links WHERE user_id = ? ORDER BY project_name`, userID)
	if err != nil {
		return nil, fmt.Errorf("list linear links: %w", err)
	}
	defer func() { _ = rows.Close() }()
	links := []LinearLink{}
	for rows.Next() {
		var link LinearLink
		if err := rows.Scan(&link.ProjectID, &link.ProjectName, &link.Repository, &link.Namespace); err != nil {
			return nil, fmt.Errorf("scan linear link: %w", err)
		}
		links = append(links, link)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read linear links: %w", err)
	}
	return links, nil
}

func (s *Store) SetLinearLinks(ctx context.Context, userID int64, links []LinearLink) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin linear links: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `DELETE FROM linear_repo_links WHERE user_id = ?`, userID); err != nil {
		return fmt.Errorf("clear linear links: %w", err)
	}
	for _, link := range links {
		if _, err := tx.ExecContext(ctx, `INSERT INTO linear_repo_links(user_id, project_id, project_name, repository, namespace) VALUES (?, ?, ?, ?, ?)`,
			userID, link.ProjectID, link.ProjectName, link.Repository, link.Namespace); err != nil {
			return fmt.Errorf("insert linear link: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit linear links: %w", err)
	}
	return nil
}
