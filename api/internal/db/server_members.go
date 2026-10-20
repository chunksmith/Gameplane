package db

import (
	"context"
	"fmt"
	"strings"
)

type ServerMember struct {
	UserID      int64
	Cluster     string
	Namespace   string
	Server      string
	ServerUID   string
	Permissions []string
}

func (s *Store) ListServerMembers(ctx context.Context, userID int64) ([]ServerMember, error) {
	rows, err := s.DB.QueryContext(ctx, `
		SELECT cluster, namespace, server, server_uid, permissions
		FROM server_members WHERE user_id = ?
		ORDER BY cluster, namespace, server`, userID)
	if err != nil {
		return nil, fmt.Errorf("list server members: %w", err)
	}
	defer func() { _ = rows.Close() }()

	members := []ServerMember{}
	for rows.Next() {
		var permissions string
		member := ServerMember{UserID: userID}
		if err := rows.Scan(&member.Cluster, &member.Namespace, &member.Server, &member.ServerUID, &permissions); err != nil {
			return nil, fmt.Errorf("scan server member: %w", err)
		}
		member.Permissions = splitPermissions(permissions)
		members = append(members, member)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate server members: %w", err)
	}
	return members, nil
}

func (s *Store) UpsertServerMember(ctx context.Context, m ServerMember) error {
	if _, err := s.DB.ExecContext(ctx, `
		INSERT INTO server_members(user_id, cluster, namespace, server, server_uid, permissions)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT (user_id, cluster, namespace, server)
		DO UPDATE SET server_uid = excluded.server_uid, permissions = excluded.permissions`,
		m.UserID, m.Cluster, m.Namespace, m.Server, m.ServerUID, strings.Join(m.Permissions, ",")); err != nil {
		return fmt.Errorf("upsert server member: %w", err)
	}
	return nil
}

func (s *Store) DeleteServerMember(ctx context.Context, userID int64, cluster, namespace, server string) (bool, error) {
	res, err := s.DB.ExecContext(ctx,
		`DELETE FROM server_members WHERE user_id = ? AND cluster = ? AND namespace = ? AND server = ?`,
		userID, cluster, namespace, server)
	if err != nil {
		return false, fmt.Errorf("delete server member: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("delete server member rows: %w", err)
	}
	return n > 0, nil
}

func (s *Store) DeleteServerMembersForServer(ctx context.Context, cluster, namespace, server string) error {
	if _, err := s.DB.ExecContext(ctx,
		`DELETE FROM server_members WHERE cluster = ? AND namespace = ? AND server = ?`,
		cluster, namespace, server); err != nil {
		return fmt.Errorf("delete server members for server: %w", err)
	}
	return nil
}

func splitPermissions(permissions string) []string {
	out := []string{}
	for _, permission := range strings.Split(permissions, ",") {
		if permission != "" {
			out = append(out, permission)
		}
	}
	return out
}
