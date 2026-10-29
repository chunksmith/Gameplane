package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"sync"
	"testing"
)

func fileToolReply(id, name, input string) string {
	return strings.Replace(toolReply(id, input), `"name":"gameplane_api"`, `"name":"`+name+`"`, 1)
}

func TestAINumbered(t *testing.T) {
	if got := aiNumbered("", 0, 0); got != "(empty file)" {
		t.Errorf("empty = %q", got)
	}
	if got := aiNumbered("a\nb", 0, 0); got != "     1\ta\n     2\tb\n" {
		t.Errorf("all = %q", got)
	}
	if got := aiNumbered("a\nb\nc\n", 2, 1); got != "     2\tb\n(lines 2-2 of 3; continue with offset=3)" {
		t.Errorf("page = %q", got)
	}
	if got := aiNumbered("a\n", 5, 0); got != "1 lines; offset 5 is past the end" {
		t.Errorf("past end = %q", got)
	}
	big := strings.Repeat(strings.Repeat("x", 999)+"\n", 60)
	if got := aiNumbered(big, 1, 0); len(got) != 60*1007 || strings.Contains(got, "continue with offset") {
		t.Errorf("full read = %d bytes", len(got))
	}
	if got := aiNumbered(strings.Repeat("y", 3000), 1, 0); got != "     1\t"+strings.Repeat("y", 3000)+"\n" {
		t.Errorf("long line = %d bytes", len(got))
	}
}

func TestAIFileTool(t *testing.T) {
	f := newAIFixture(t, true)
	f.routes["GET /servers/lobby/files/read"] = func() (int, string) { return http.StatusOK, "a: 1\nb: 1\n" }
	f.routes["POST /servers/lobby/files/write"] = func() (int, string) { return http.StatusNoContent, "" }
	lobby := aiConversation{Server: "lobby", Namespace: "games", Cluster: "local"}
	cases := []struct {
		conv   aiConversation
		name   string
		input  string
		want   string
		failed bool
	}{
		{lobby, aiReadFile, `{"file_path":"config.yml"}`, "absolute path", true},
		{lobby, aiReadFile, `{"file_path":"/c.yml","offset":2}`, "     2\tb: 1\n", false},
		{lobby, aiEditFile, `{"file_path":"/c.yml","old_string":"","new_string":"y"}`, "must be non-empty", true},
		{lobby, aiEditFile, `{"file_path":"/c.yml","old_string":"x","new_string":"y"}`, "was not found", true},
		{lobby, aiEditFile, `{"file_path":"/c.yml","old_string":": 1","new_string":": 2"}`, "appears 2 times", true},
		{lobby, aiEditFile, `{"file_path":"/c.yml","old_string":": 1","new_string":": 2","replace_all":true}`, "Edited /c.yml: 2 replacement(s)", false},
		{lobby, aiWriteFile, `{"file_path":"/new.yml","content":"x: 1\n"}`, "Wrote 5 bytes to /new.yml", false},
		{lobby, aiReadFile, `{"file_path":"/c.yml","server":"survival"}`, "limited to server lobby", true},
		{lobby, aiReadFile, `{"file_path":"/c.yml","offset":2,"limit":9223372036854775807}`, "     2\tb: 1\n", false},
		{aiConversation{}, aiReadFile, `{"file_path":"/c.yml"}`, "server and namespace are required", true},
		{aiConversation{}, aiReadFile, `{"file_path":"/c.yml","server":"other","namespace":"g"}`, "HTTP 403", true},
	}
	for _, tc := range cases {
		got, failed := f.h.fileTool(context.Background(), tc.conv, aiCreds{}, tc.name, json.RawMessage(tc.input))
		if failed != tc.failed || !strings.Contains(got, tc.want) {
			t.Errorf("%s %s = %q (%v), want %q (%v)", tc.name, tc.input, got, failed, tc.want, tc.failed)
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	writes := []string{}
	for _, call := range f.calls {
		if call.method == http.MethodPost {
			writes = append(writes, call.target+" "+call.body)
		}
	}
	want := []string{"/servers/lobby/files/write?cluster=local&namespace=games&path=%2Fc.yml a: 2\nb: 2\n", "/servers/lobby/files/write?cluster=local&namespace=games&path=%2Fnew.yml x: 1\n"}
	if !slices.Equal(writes, want) {
		t.Errorf("writes = %q", writes)
	}
}

func TestAIFileToolsRun(t *testing.T) {
	f := newAIFixture(t, true)
	f.routes["GET /servers/lobby/files/read"] = func() (int, string) { return http.StatusOK, "motd: old\nmax: 10\n" }
	f.routes["POST /servers/lobby/files/write"] = func() (int, string) { return http.StatusNoContent, "" }
	f.script(nil,
		fileToolReply("t1", aiReadFile, `{"file_path":"/config.yml","server":"lobby","namespace":"evil"}`),
		fileToolReply("t2", aiEditFile, `{"file_path":"/config.yml","old_string":"motd: old","new_string":"motd: new"}`),
		textReply("Done", "end_turn"),
	)
	conv := f.create(map[string]any{"prompt": "Change the motd", "server": "lobby", "namespace": "games"})
	f.wait(conv.ID, aiIdle)
	f.mu.Lock()
	write := f.calls[len(f.calls)-1]
	f.mu.Unlock()
	if write.method != http.MethodPost || write.target != "/servers/lobby/files/write?cluster=local&namespace=games&path=%2Fconfig.yml" || write.body != "motd: new\nmax: 10\n" || write.cookie != "gameplane_session=s1" {
		t.Errorf("write = %+v", write)
	}
	_, msgs, _ := f.detail(conv.ID, "")
	if len(msgs) != 6 || !strings.Contains(string(msgs[2]), `     1\tmotd: old`) || !strings.Contains(string(msgs[4]), "Edited /config.yml: 1 replacement(s)") {
		t.Fatalf("messages = %s", msgs)
	}
}

func TestAIEditFileCRLF(t *testing.T) {
	f := newAIFixture(t, true)
	f.routes["GET /servers/lobby/files/read"] = func() (int, string) { return http.StatusOK, "a: 1\r\nb: 1\r\n" }
	f.routes["POST /servers/lobby/files/write"] = func() (int, string) { return http.StatusNoContent, "" }
	conv := aiConversation{Server: "lobby", Namespace: "games", Cluster: "local"}
	got, failed := f.h.fileTool(context.Background(), conv, aiCreds{}, aiEditFile, json.RawMessage(`{"file_path":"/c.yml","old_string":"a: 1\nb: 1","new_string":"a: 2\nb: 2"}`))
	if failed || got != "Edited /c.yml: 1 replacement(s)" {
		t.Fatalf("edit = %q (%v)", got, failed)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if last := f.calls[len(f.calls)-1]; last.body != "a: 2\r\nb: 2\r\n" {
		t.Errorf("write body = %q", last.body)
	}
}

func TestAIShellOutput(t *testing.T) {
	if got := aiShellOutput("a\n", "", 0); got != "exit 0\na\n" {
		t.Errorf("plain = %q", got)
	}
	if got := aiShellOutput("", "boom", 2); !strings.Contains(got, "exit 2") || !strings.Contains(got, "[stderr]\nboom") {
		t.Errorf("stderr = %q", got)
	}
	if got := aiShellOutput(strings.Repeat("x", 60000), "", 0); got != "exit 0\n"+strings.Repeat("x", 60000) {
		t.Errorf("long output = %d bytes", len(got))
	}
}

func TestAICheckServer(t *testing.T) {
	lobby := aiConversation{Server: "lobby"}
	if aiCheckServer(lobby, aiFileInput{Server: "other"}) == nil {
		t.Error("other server allowed")
	}
	if aiCheckServer(aiConversation{}, aiFileInput{}) == nil {
		t.Error("empty server allowed")
	}
	if err := aiCheckServer(lobby, aiFileInput{}); err != nil {
		t.Errorf("own server = %v", err)
	}
}

func TestAICLIFileTool(t *testing.T) {
	var mu sync.Mutex
	var result string
	f, _ := newCLIFixture(t, func(call *aiSpawn, emit func(string)) {
		emit(cliInit)
		text := cliCall(t, call.args, aiReadFile, map[string]any{"file_path": "/config.yml", "limit": 1})
		mu.Lock()
		result = text
		mu.Unlock()
		emit(cliDone)
	})
	f.routes["GET /servers/lobby/files/read"] = func() (int, string) { return http.StatusOK, "a: 1\nb: 2\n" }
	conv := f.create(map[string]any{"prompt": "read it", "server": "lobby", "namespace": "games"})
	f.wait(conv.ID, aiIdle)
	mu.Lock()
	defer mu.Unlock()
	if result != "     1\ta: 1\n(lines 1-1 of 2; continue with offset=2)" {
		t.Errorf("read_file = %q", result)
	}
}
