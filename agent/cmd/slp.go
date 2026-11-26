package main

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"regexp"
	"strings"
	"time"
)

const (
	statusAddr      = "127.0.0.1:25565"
	statusTimeout   = 2 * time.Second
	maxStatusPacket = 2 << 20
	anonymousID     = "00000000-0000-0000-0000-000000000000"
)

var (
	statusRequest = append(append([]byte{0x10, 0x00, 0xff, 0x05, 0x09}, "127.0.0.1"...), 0x63, 0xdd, 0x01, 0x01, 0x00)
	playerNameRE  = regexp.MustCompile(`^[A-Za-z0-9_]{1,16}$`)
)

type statusFallback struct {
	rcon interface {
		Exec(cmd string) (string, error)
	}
	addr string
}

func (fallback statusFallback) Exec(cmd string) (string, error) {
	out, err := fallback.rcon.Exec(cmd)
	if err == nil || cmd != "list" {
		return out, err
	}
	status, pingErr := serverListPing(context.Background(), fallback.addr)
	if pingErr != nil {
		return "", err
	}
	return fmt.Sprintf("There are %d of a max of %d players online: %s", status.online, status.maxPlayers, strings.Join(status.names, ", ")), nil
}

type serverStatus struct {
	online     int
	maxPlayers int
	names      []string
}

func serverListPing(ctx context.Context, addr string) (serverStatus, error) {
	dialer := net.Dialer{Timeout: statusTimeout}
	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return serverStatus{}, fmt.Errorf("status dial: %w", err)
	}
	defer func() { _ = conn.Close() }()
	if err := conn.SetDeadline(time.Now().Add(statusTimeout)); err != nil {
		return serverStatus{}, fmt.Errorf("status deadline: %w", err)
	}
	if _, err := conn.Write(statusRequest); err != nil {
		return serverStatus{}, fmt.Errorf("status write: %w", err)
	}
	reader := bufio.NewReader(conn)
	length, err := binary.ReadUvarint(reader)
	if err != nil {
		return serverStatus{}, fmt.Errorf("status length: %w", err)
	}
	if length == 0 || length > maxStatusPacket {
		return serverStatus{}, fmt.Errorf("status packet length %d out of range", length)
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(reader, body); err != nil {
		return serverStatus{}, fmt.Errorf("status body: %w", err)
	}
	return parseStatus(body)
}

func parseStatus(body []byte) (serverStatus, error) {
	packetID, idSize := binary.Uvarint(body)
	if idSize <= 0 || packetID != 0x00 {
		return serverStatus{}, errors.New("not a status response")
	}
	_, lengthSize := binary.Uvarint(body[idSize:])
	if lengthSize <= 0 {
		return serverStatus{}, errors.New("truncated status response")
	}
	var response struct {
		Players *struct {
			Online int `json:"online"`
			Max    int `json:"max"`
			Sample []struct {
				Name string `json:"name"`
				ID   string `json:"id"`
			} `json:"sample"`
		} `json:"players"`
	}
	if err := json.Unmarshal(body[idSize+lengthSize:], &response); err != nil {
		return serverStatus{}, fmt.Errorf("status json: %w", err)
	}
	if response.Players == nil {
		return serverStatus{}, errors.New("status response has no players")
	}
	names := []string{}
	for _, player := range response.Players.Sample {
		if player.ID != anonymousID && playerNameRE.MatchString(player.Name) {
			names = append(names, player.Name)
		}
	}
	return serverStatus{online: response.Players.Online, maxPlayers: response.Players.Max, names: names}, nil
}
