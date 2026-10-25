package auth

import (
	"slices"
	"testing"
)

func TestUserServerGrant_MatchesPinnedUID(t *testing.T) {
	u := &User{ServerGrants: map[ServerKey]ServerGrant{
		{"local", "games", "alpha"}: {UID: "uid-1", Permissions: []string{"servers:write"}},
		{"local", "games", "beta"}:  {Permissions: []string{"servers:console"}},
	}}

	if permissions, ok := u.ServerGrant("local", "games", "alpha", "uid-1"); !ok || !slices.Equal(permissions, []string{"servers:write"}) {
		t.Fatalf("matching UID = %v, %v; want servers:write, true", permissions, ok)
	}
	if _, ok := u.ServerGrant("local", "games", "alpha", "uid-2"); ok {
		t.Fatal("UID mismatch granted access")
	}
	if _, ok := u.ServerGrant("local", "games", "beta", "any-uid"); !ok {
		t.Fatal("empty UID grant should match any UID")
	}
	if _, ok := u.ServerGrant("local", "games", "gamma", "uid-1"); ok {
		t.Fatal("missing grant granted access")
	}
}
