package auth

import (
	"context"
	"reflect"
	"testing"
)

func TestLoadNetworks_ReturnsMembershipPermissions(t *testing.T) {
	s := newAuthDB(t)
	seedUser(t, s, "alice", "pw", "member")
	if _, err := s.DB.ExecContext(context.Background(),
		`INSERT INTO network_members(network_name, user_id) VALUES ('skyblock', 1)`); err != nil {
		t.Fatalf("insert default membership: %v", err)
	}
	if _, err := s.DB.ExecContext(context.Background(),
		`INSERT INTO network_members(network_name, user_id, permissions) VALUES ('smp', 1, '')`); err != nil {
		t.Fatalf("insert view-only membership: %v", err)
	}
	networks, err := NewSessionStore(s).LoadNetworks(context.Background(), 1)
	if err != nil {
		t.Fatalf("LoadNetworks: %v", err)
	}
	want := map[string][]string{"skyblock": {"servers:console", "servers:write"}, "smp": {}}
	if !reflect.DeepEqual(networks, want) {
		t.Fatalf("networks = %v, want %v", networks, want)
	}
	none, err := NewSessionStore(s).LoadNetworks(context.Background(), 2)
	if err != nil || len(none) != 0 {
		t.Fatalf("unknown user networks = %v, err %v", none, err)
	}
}
