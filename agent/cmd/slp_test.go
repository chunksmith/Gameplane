package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"testing"

	"github.com/GameplanePanel/gameplane/agent/internal/rcon"
)

func fakeStatusServer(t *testing.T, response string) string {
	t.Helper()
	listener, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		request := make([]byte, len(statusRequest))
		if _, err := io.ReadFull(conn, request); err != nil || !bytes.Equal(request, statusRequest) {
			return
		}
		body := binary.AppendUvarint([]byte{0x00}, uint64(len(response)))
		body = append(body, response...)
		_, _ = conn.Write(append(binary.AppendUvarint(nil, uint64(len(body))), body...))
	}()
	return listener.Addr().String()
}

func TestStatusFallbackSynthesizesList(t *testing.T) {
	addr := fakeStatusServer(t, `{"players":{"online":8,"max":600,"sample":[`+
		`{"name":"Herobitine","id":"3e5f844d-b1c9-3f0a-ba81-457f7f105aa3"},`+
		`{"name":"Anonymous Player","id":"00000000-0000-0000-0000-000000000000"},`+
		`{"name":"§cChicken Network","id":"01a2196d-6018-7f74-beb7-df9c3e40184b"},`+
		`{"name":"ALT3N","id":"b5ab790a-327d-3604-8e3c-3f53c59f036a"}]}}`)
	out, err := statusFallback{rcon: rcon.Disabled{}, addr: addr}.Exec("list")
	if err != nil {
		t.Fatal(err)
	}
	if want := "There are 8 of a max of 600 players online: Herobitine, ALT3N"; out != want {
		t.Fatalf("got %q, want %q", out, want)
	}
}

func TestStatusFallbackKeepsRCONErrorWhenPingFails(t *testing.T) {
	addr := fakeStatusServer(t, `{"version":{"name":"x"}}`)
	if _, err := (statusFallback{rcon: rcon.Disabled{}, addr: addr}).Exec("list"); !errors.Is(err, rcon.ErrDisabled) {
		t.Fatalf("got %v, want rcon.ErrDisabled", err)
	}
	if _, err := (statusFallback{rcon: rcon.Disabled{}, addr: addr}).Exec("kick Steve"); !errors.Is(err, rcon.ErrDisabled) {
		t.Fatalf("got %v, want rcon.ErrDisabled", err)
	}
}

func TestParseStatusRejectsOtherPackets(t *testing.T) {
	if _, err := parseStatus([]byte{0x01, 0x02, '{', '}'}); err == nil {
		t.Fatal("want error for a non-status packet")
	}
	if _, err := parseStatus([]byte{0x00}); err == nil {
		t.Fatal("want error for a truncated packet")
	}
}
