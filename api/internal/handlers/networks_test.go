package handlers

import (
	"encoding/json"
	"net/http/httptest"
	"slices"
	"strconv"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/GameplanePanel/gameplane/api/internal/db"
)

func newNetworksServer(t *testing.T) (*httptest.Server, *db.Store) {
	t.Helper()
	store := newTestStore(t)
	r := chi.NewRouter()
	mountNetworks(r, store)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return srv, store
}

func TestNetworks_Lifecycle(t *testing.T) {
	srv, store := newNetworksServer(t)
	if status, body := doReq(t, "POST", srv.URL+"/networks", map[string]any{"name": "skyblock"}); status != 201 {
		t.Fatalf("create want 201 got %d body=%s", status, body)
	}
	if status, _ := doReq(t, "POST", srv.URL+"/networks", map[string]any{"name": "skyblock"}); status != 409 {
		t.Fatalf("duplicate want 409 got %d", status)
	}
	if status, _ := doReq(t, "POST", srv.URL+"/networks", map[string]any{"name": "bad name"}); status != 400 {
		t.Fatalf("invalid name want 400 got %d", status)
	}
	id := seedUser(t, store, "ayse", "member", "")
	member := srv.URL + "/networks/skyblock/members/" + strconv.FormatInt(id, 10)
	if status, _ := doReq(t, "PUT", member, nil); status != 400 {
		t.Fatalf("add member without body want 400 got %d", status)
	}
	if status, _ := doReq(t, "PUT", member, map[string]any{"permissions": []string{"*"}}); status != 400 {
		t.Fatalf("add member with unknown permission want 400 got %d", status)
	}
	if status, body := doReq(t, "PUT", member, map[string]any{"permissions": []string{"servers:console"}}); status != 204 {
		t.Fatalf("add member want 204 got %d body=%s", status, body)
	}
	if status, _ := doReq(t, "PUT", member, map[string]any{"permissions": []string{"servers:write", "servers:console", "servers:write"}}); status != 204 {
		t.Fatalf("update member permissions want 204 got %d", status)
	}
	if status, _ := doReq(t, "PUT", srv.URL+"/networks/missing/members/"+strconv.FormatInt(id, 10), nil); status != 404 {
		t.Fatalf("unknown network want 404 got %d", status)
	}
	if status, _ := doReq(t, "PUT", srv.URL+"/networks/skyblock/members/999", nil); status != 404 {
		t.Fatalf("unknown user want 404 got %d", status)
	}
	status, body := doReq(t, "GET", srv.URL+"/networks", nil)
	if status != 200 {
		t.Fatalf("list want 200 got %d", status)
	}
	var networks []networkDTO
	if err := json.Unmarshal(body, &networks); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(networks) != 1 || len(networks[0].Members) != 1 || networks[0].Members[0].Username != "ayse" ||
		!slices.Equal(networks[0].Members[0].Permissions, []string{"servers:console", "servers:write"}) {
		t.Fatalf("list = %+v", networks)
	}
	if status, _ := doReq(t, "DELETE", member, nil); status != 204 {
		t.Fatalf("remove member want 204 got %d", status)
	}
	if status, _ := doReq(t, "DELETE", member, nil); status != 404 {
		t.Fatalf("repeat remove want 404 got %d", status)
	}
	if status, _ := doReq(t, "PUT", member, map[string]any{"permissions": []string{}}); status != 204 {
		t.Fatalf("re-add view-only member want 204 got %d", status)
	}
	if status, _ := doReq(t, "DELETE", srv.URL+"/networks/skyblock", nil); status != 204 {
		t.Fatalf("delete want 204 got %d", status)
	}
	if status, _ := doReq(t, "DELETE", srv.URL+"/networks/skyblock", nil); status != 404 {
		t.Fatalf("repeat delete want 404 got %d", status)
	}
	var left int
	if err := store.DB.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM network_members`).Scan(&left); err != nil || left != 0 {
		t.Fatalf("members left = %d, err %v", left, err)
	}
}

func TestDeleteUser_RemovesNetworkMembership(t *testing.T) {
	store := newTestStore(t)
	id := seedUser(t, store, "mert", "member", "")
	if _, err := store.DB.ExecContext(t.Context(), `INSERT INTO networks(name) VALUES ('smp')`); err != nil {
		t.Fatalf("insert network: %v", err)
	}
	if _, err := store.DB.ExecContext(t.Context(), `INSERT INTO network_members(network_name, user_id) VALUES ('smp', ?)`, id); err != nil {
		t.Fatalf("insert member: %v", err)
	}
	if err := store.DeleteUser(t.Context(), id); err != nil {
		t.Fatalf("DeleteUser: %v", err)
	}
	var left int
	if err := store.DB.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM network_members`).Scan(&left); err != nil || left != 0 {
		t.Fatalf("members left = %d, err %v", left, err)
	}
}
