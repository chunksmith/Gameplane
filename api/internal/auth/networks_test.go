package auth

import (
	"context"
	"slices"
	"testing"
)

func TestLoadNetworks_ReturnsMemberships(t *testing.T) {
	s := newAuthDB(t)
	seedUser(t, s, "alice", "pw", "member")
	for _, network := range []string{"smp", "skyblock"} {
		if _, err := s.DB.ExecContext(context.Background(),
			`INSERT INTO network_members(network_name, user_id) VALUES (?, 1)`, network); err != nil {
			t.Fatalf("insert membership %s: %v", network, err)
		}
	}
	networks, err := NewSessionStore(s).LoadNetworks(context.Background(), 1)
	if err != nil {
		t.Fatalf("LoadNetworks: %v", err)
	}
	if !slices.Equal(networks, []string{"skyblock", "smp"}) {
		t.Fatalf("networks = %v, want [skyblock smp]", networks)
	}
	none, err := NewSessionStore(s).LoadNetworks(context.Background(), 2)
	if err != nil || len(none) != 0 {
		t.Fatalf("unknown user networks = %v, err %v", none, err)
	}
}
