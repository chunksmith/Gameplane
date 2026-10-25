package handlers

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	aiReadFile  = "read_file"
	aiEditFile  = "edit_file"
	aiWriteFile = "write_file"
	aiReadLines = 2000
	aiLineLimit = 2000
)

type aiToolSpec struct {
	name        string
	description string
	properties  map[string]any
	required    []string
}

func (s aiToolSpec) beta() anthropic.BetaToolUnionParam {
	return anthropic.BetaToolUnionParam{OfTool: &anthropic.BetaToolParam{
		Name:        s.name,
		Description: anthropic.String(s.description),
		InputSchema: anthropic.BetaToolInputSchemaParam{Properties: s.properties, Required: s.required},
	}}
}

func (s aiToolSpec) mcp() *mcp.Tool {
	return &mcp.Tool{Name: s.name, Description: s.description, InputSchema: map[string]any{"type": "object", "properties": s.properties, "required": s.required}}
}

var aiFileScope = map[string]any{
	"file_path": map[string]any{"type": "string", "description": "Absolute path inside the server's data volume, for example /plugins/Essentials/config.yml"},
	"server":    map[string]any{"type": "string", "description": "Server name; only in a conversation that is not tied to one server"},
	"namespace": map[string]any{"type": "string", "description": "The server's namespace; only with server"},
	"cluster":   map[string]any{"type": "string", "description": "The server's cluster when it is not \"local\"; only with server"},
}

func aiFileSpec(name, description string, required []string, extra map[string]any) aiToolSpec {
	properties := maps.Clone(aiFileScope)
	maps.Copy(properties, extra)
	return aiToolSpec{name: name, description: description, properties: properties, required: append([]string{"file_path"}, required...)}
}

var aiTools = []aiToolSpec{
	{name: "gameplane_api", description: aiToolDescription, properties: aiToolProperties, required: aiToolRequired},
	aiFileSpec(aiReadFile, "Read a text file from a server's data volume with line numbers, 2000 lines at a time. Use offset (first line, 1-based) and limit (number of lines) to page through long files.", nil, map[string]any{
		"offset": map[string]any{"type": "integer", "description": "First line to show, 1-based (default 1)"},
		"limit":  map[string]any{"type": "integer", "description": "Number of lines to show (default 2000)"},
	}),
	aiFileSpec(aiEditFile, "Replace text in a file on a server's data volume. old_string must match the file exactly and only once (include surrounding lines to make it unique) unless replace_all is true; the line-number prefixes shown by read_file are not part of the file. Use this for every change to an existing file instead of rewriting it.", []string{"old_string", "new_string"}, map[string]any{
		"old_string":  map[string]any{"type": "string", "description": "The exact text to replace"},
		"new_string":  map[string]any{"type": "string", "description": "The text that replaces it"},
		"replace_all": map[string]any{"type": "boolean", "description": "Replace every occurrence (default false)"},
	}),
	aiFileSpec(aiWriteFile, "Create or overwrite a file on a server's data volume with the given content. Use edit_file for changes to an existing file.", []string{"content"}, map[string]any{
		"content": map[string]any{"type": "string", "description": "The complete file content"},
	}),
}

func aiIsFileTool(name string) bool {
	return name == aiReadFile || name == aiEditFile || name == aiWriteFile
}

func aiMCPTools() []string {
	out := make([]string, len(aiTools))
	for i, spec := range aiTools {
		out[i] = aiMCPPrefix + spec.name
	}
	return out
}

func aiBetaTools() []anthropic.BetaToolUnionParam {
	out := make([]anthropic.BetaToolUnionParam, len(aiTools))
	for i, spec := range aiTools {
		out[i] = spec.beta()
	}
	return out
}

type aiFileInput struct {
	Server     string `json:"server"`
	Namespace  string `json:"namespace"`
	Cluster    string `json:"cluster"`
	Path       string `json:"file_path"`
	Offset     int    `json:"offset"`
	Limit      int    `json:"limit"`
	Old        string `json:"old_string"`
	New        string `json:"new_string"`
	ReplaceAll bool   `json:"replace_all"`
	Content    string `json:"content"`
}

func (h *aiHandler) fileTool(ctx context.Context, conv aiConversation, creds aiCreds, name string, raw json.RawMessage) (string, bool) {
	var in aiFileInput
	if err := json.Unmarshal(raw, &in); err != nil {
		return "Invalid tool input: " + err.Error(), true
	}
	if err := aiCheckFile(conv, in); err != nil {
		return err.Error(), true
	}
	switch name {
	case aiReadFile:
		return h.readFile(ctx, conv, creds, in)
	case aiEditFile:
		return h.editFile(ctx, conv, creds, in)
	}
	return h.storeFile(ctx, conv, creds, in, in.Content, fmt.Sprintf("Wrote %d bytes to %s", len(in.Content), in.Path))
}

func aiCheckFile(conv aiConversation, in aiFileInput) error {
	if !strings.HasPrefix(in.Path, "/") {
		return errors.New("file_path must be an absolute path inside the server's data volume")
	}
	if conv.Server == "" && (!dnsLabelRE.MatchString(in.Server) || in.Namespace == "") {
		return errors.New("server and namespace are required in this conversation")
	}
	if conv.Server != "" && in.Server != "" && in.Server != conv.Server {
		return fmt.Errorf("this conversation is limited to server %s", conv.Server)
	}
	return nil
}

func (h *aiHandler) fileCall(ctx context.Context, conv aiConversation, creds aiCreds, method, op string, in aiFileInput, body []byte) (int, []byte) {
	call := aiToolInput{Method: method, Path: "/servers/" + cmp.Or(conv.Server, in.Server) + "/files/" + op, Query: map[string]string{"path": in.Path}}
	if conv.Server == "" {
		call.Query["namespace"] = in.Namespace
		if in.Cluster != "" {
			call.Query["cluster"] = in.Cluster
		}
	}
	return h.request(ctx, conv, creds, call, body, "application/octet-stream")
}

func (h *aiHandler) readFile(ctx context.Context, conv aiConversation, creds aiCreds, in aiFileInput) (string, bool) {
	content, failed := h.loadFile(ctx, conv, creds, in)
	if failed {
		return content, true
	}
	return aiNumbered(content, in.Offset, in.Limit), false
}

func (h *aiHandler) loadFile(ctx context.Context, conv aiConversation, creds aiCreds, in aiFileInput) (string, bool) {
	status, data := h.fileCall(ctx, conv, creds, http.MethodGet, "read", in, nil)
	switch {
	case status != http.StatusOK:
		return fmt.Sprintf("HTTP %d\n%s", status, aiResultText(data)), true
	case !utf8.Valid(data):
		return fmt.Sprintf("%s is a binary file (%d bytes)", in.Path, len(data)), true
	}
	return string(data), false
}

func (h *aiHandler) editFile(ctx context.Context, conv aiConversation, creds aiCreds, in aiFileInput) (string, bool) {
	if in.Old == "" || in.Old == in.New {
		return "old_string must be non-empty and differ from new_string", true
	}
	content, failed := h.loadFile(ctx, conv, creds, in)
	if failed {
		return content, true
	}
	if strings.Contains(content, "\r\n") && !strings.Contains(in.Old, "\r") {
		in.Old, in.New = strings.ReplaceAll(in.Old, "\n", "\r\n"), strings.ReplaceAll(in.New, "\n", "\r\n")
	}
	count := strings.Count(content, in.Old)
	switch {
	case count == 0:
		return fmt.Sprintf("old_string was not found in %s; read the file again and copy the text exactly", in.Path), true
	case count > 1 && !in.ReplaceAll:
		return fmt.Sprintf("old_string appears %d times in %s; include more surrounding text so it matches once, or set replace_all", count, in.Path), true
	}
	replacements := 1
	if in.ReplaceAll {
		replacements = -1
	}
	return h.storeFile(ctx, conv, creds, in, strings.Replace(content, in.Old, in.New, replacements), fmt.Sprintf("Edited %s: %d replacement(s)", in.Path, count))
}

func (h *aiHandler) storeFile(ctx context.Context, conv aiConversation, creds aiCreds, in aiFileInput, content, done string) (string, bool) {
	status, data := h.fileCall(ctx, conv, creds, http.MethodPost, "write", in, []byte(content))
	if status >= http.StatusBadRequest {
		return fmt.Sprintf("HTTP %d\n%s", status, aiResultText(data)), true
	}
	return done, false
}

func aiNumbered(content string, offset, limit int) string {
	if content == "" {
		return "(empty file)"
	}
	lines := strings.Split(strings.TrimSuffix(content, "\n"), "\n")
	start, total := max(offset, 1), len(lines)
	if limit <= 0 {
		limit = aiReadLines
	}
	limit = min(limit, total)
	if start > total {
		return fmt.Sprintf("%d lines; offset %d is past the end", total, start)
	}
	end := min(start+limit-1, total)
	var b strings.Builder
	for i := start; i <= end; i++ {
		line := fmt.Sprintf("%6d\t%s\n", i, aiClip(lines[i-1], aiLineLimit))
		if b.Len()+len(line) > aiMaxResult && i > start {
			end = i - 1
			break
		}
		b.WriteString(line)
	}
	if end < total {
		fmt.Fprintf(&b, "(lines %d-%d of %d; continue with offset=%d)", start, end, total, end+1)
	}
	return b.String()
}
