package handlers

import (
	"archive/zip"
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"path"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	aiReadFile     = "read_file"
	aiEditFile     = "edit_file"
	aiWriteFile    = "write_file"
	aiReadArchive  = "read_archive"
	aiShell        = "shell"
	aiCLIResultMax = 500000
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
	return &mcp.Tool{Name: s.name, Description: s.description, InputSchema: map[string]any{"type": "object", "properties": s.properties, "required": s.required}, Meta: mcp.Meta{"anthropic/maxResultSizeChars": aiCLIResultMax}}
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

var aiServerScope = map[string]any{
	"server":    aiFileScope["server"],
	"namespace": aiFileScope["namespace"],
	"cluster":   aiFileScope["cluster"],
}

func aiScopedSpec(name, description string, required []string, extra map[string]any) aiToolSpec {
	properties := maps.Clone(aiServerScope)
	maps.Copy(properties, extra)
	return aiToolSpec{name: name, description: description, properties: properties, required: required}
}

var aiShellProperties = map[string]any{
	"command":           map[string]any{"type": "string", "description": "The shell command, run with sh -c in the data volume folder"},
	"timeout_seconds":   map[string]any{"type": "integer", "description": "Stop the command after this many seconds (default 30)"},
	"run_in_background": map[string]any{"type": "boolean", "description": "Start the command in the background and return a job id at once; read it later with shell_output. Use it for commands that run longer than a minute, such as a test boot or a long download."},
	"server":            aiFileScope["server"],
	"namespace":         aiFileScope["namespace"],
	"cluster":           aiFileScope["cluster"],
}

var aiTools = []aiToolSpec{
	{name: "gameplane_api", description: aiToolDescription, properties: aiToolProperties, required: aiToolRequired},
	aiFileSpec(aiReadFile, "Read a text file from a server's data volume with line numbers. Use offset (first line, 1-based) and limit (number of lines) to read part of a long file.", nil, map[string]any{
		"offset": map[string]any{"type": "integer", "description": "First line to show, 1-based (default 1)"},
		"limit":  map[string]any{"type": "integer", "description": "Number of lines to show (default: the rest of the file)"},
	}),
	aiFileSpec(aiEditFile, "Replace text in a file on a server's data volume. old_string must match the file exactly and only once (include surrounding lines to make it unique) unless replace_all is true; the line-number prefixes shown by read_file are not part of the file. Use this for every change to an existing file instead of rewriting it.", []string{"old_string", "new_string"}, map[string]any{
		"old_string":  map[string]any{"type": "string", "description": "The exact text to replace"},
		"new_string":  map[string]any{"type": "string", "description": "The text that replaces it"},
		"replace_all": map[string]any{"type": "boolean", "description": "Replace every occurrence (default false)"},
	}),
	aiFileSpec(aiWriteFile, "Create or overwrite a file on a server's data volume with the given content. Use edit_file for changes to an existing file.", []string{"content"}, map[string]any{
		"content": map[string]any{"type": "string", "description": "The complete file content"},
	}),
	aiFileSpec(aiReadArchive, "Look inside a .jar or .zip archive on a server's data volume. Without entry it lists the files in the archive; with entry it shows that text file with line numbers, for example plugin.yml, paper-plugin.yml, fabric.mod.json or a bundled default config.yml. A last resort: use it only when the server's own files do not show which settings or values a plugin or mod supports.", nil, map[string]any{
		"entry":  map[string]any{"type": "string", "description": "Path of a text file inside the archive as listed, for example plugin.yml; omit it to list the archive"},
		"offset": map[string]any{"type": "integer", "description": "First line of entry to show, 1-based (default 1)"},
		"limit":  map[string]any{"type": "integer", "description": "Number of lines of entry to show (default: the rest of the entry)"},
	}),
	{name: aiShell, description: "Run a shell command (sh -c) in the server's game container, inside its data volume: the same files read_file shows, so read_file's /plugins is ./plugins here. Use it like a terminal to search and inspect: grep -rn, find, ls -la, head, tail, wc, unzip -l some.jar, unzip -p some.jar plugin.yml. Returns the exit code, stdout and stderr; a command stops after timeout_seconds (default 30). Change files with edit_file or write_file, not with shell redirects or sed. Available programs depend on the game image; when one is missing, use read_file or read_archive instead. Set run_in_background for long commands and follow them with shell_output.", properties: aiShellProperties, required: []string{"command"}},
	aiScopedSpec(aiGrep, "Search file contents in a server's data volume with an extended regular expression, like grep -rn. path is the folder or file to search (default /), glob limits the files by name (for example *.yml), files_only lists matching files instead of lines. Returns the matching lines as path:line:text. Use it instead of shell grep.", []string{"pattern"}, map[string]any{
		"pattern":     map[string]any{"type": "string", "description": "Extended regular expression to search for"},
		"path":        map[string]any{"type": "string", "description": "Folder or file to search, for example /plugins (default /)"},
		"glob":        map[string]any{"type": "string", "description": "Only search files whose name matches, for example *.yml"},
		"ignore_case": map[string]any{"type": "boolean", "description": "Match regardless of case"},
		"files_only":  map[string]any{"type": "boolean", "description": "List the matching file paths instead of lines"},
	}),
	aiScopedSpec(aiGlob, "Find files in a server's data volume by name pattern, like Claude Code's Glob: * matches within one folder, ** across folders, for example plugins/**/*.yml. path is the folder to start from (default /). Returns the matching paths.", []string{"pattern"}, map[string]any{
		"pattern": map[string]any{"type": "string", "description": "Name pattern, for example plugins/**/*.yml or *.jar"},
		"path":    map[string]any{"type": "string", "description": "Folder to start from (default /)"},
	}),
	aiScopedSpec(aiJobOutput, "Show the status and the output of a background shell job. wait_seconds waits for the job to finish first.", []string{"job_id"}, map[string]any{
		"job_id":       map[string]any{"type": "string", "description": "The job id that shell returned"},
		"wait_seconds": map[string]any{"type": "integer", "description": "Wait up to this many seconds for the job to finish"},
	}),
	aiScopedSpec(aiJobStop, "Stop a background shell job.", []string{"job_id"}, map[string]any{
		"job_id": map[string]any{"type": "string", "description": "The job id that shell returned"},
	}),
	{name: aiWebFetch, description: "Fetch a public web page or file over http or https and return it as text (HTML tags removed); offset skips that many characters. Private, cluster and metadata addresses are blocked.", properties: map[string]any{
		"url":    map[string]any{"type": "string", "description": "Absolute http or https URL"},
		"offset": map[string]any{"type": "integer", "description": "Character offset to start from (default 0)"},
	}, required: []string{"url"}},
	{name: aiTodoWrite, description: "Keep a short task list for multi-step work that the user sees in the panel. Send the whole list every time; mark one task in_progress while you work on it and completed when it is done.", properties: map[string]any{
		"todos": map[string]any{"type": "array", "description": "The whole task list", "items": map[string]any{"type": "object", "properties": map[string]any{
			"content": map[string]any{"type": "string"},
			"status":  map[string]any{"type": "string", "enum": aiTodoStatuses},
		}, "required": []string{"content", "status"}}},
	}, required: []string{"todos"}},
}

func aiIsFileTool(name string) bool {
	return slices.Contains([]string{aiReadFile, aiEditFile, aiWriteFile, aiReadArchive, aiShell, aiGrep, aiGlob, aiJobOutput, aiJobStop}, name)
}

func aiMCPTools() []string {
	var out []string
	for _, spec := range slices.Concat(aiTools, aiCLITools) {
		out = append(out, aiMCPPrefix+spec.name)
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
	Entry      string `json:"entry"`
	Command    string `json:"command"`
	Timeout    int    `json:"timeout_seconds"`
	Dir        string `json:"path"`
	Pattern    string `json:"pattern"`
	Glob       string `json:"glob"`
	IgnoreCase bool   `json:"ignore_case"`
	FilesOnly  bool   `json:"files_only"`
	Background bool   `json:"run_in_background"`
	JobID      string `json:"job_id"`
	Wait       int    `json:"wait_seconds"`
}

func (h *aiHandler) fileTool(ctx context.Context, conv aiConversation, creds aiCreds, name string, raw json.RawMessage) (string, bool) {
	var in aiFileInput
	if err := json.Unmarshal(raw, &in); err != nil {
		return "Invalid tool input: " + err.Error(), true
	}
	switch name {
	case aiShell:
		return h.shell(ctx, conv, creds, in)
	case aiGrep:
		return h.grep(ctx, conv, creds, in)
	case aiGlob:
		return h.glob(ctx, conv, creds, in)
	case aiJobOutput:
		return h.jobOutput(ctx, conv, creds, in)
	case aiJobStop:
		return h.jobStop(ctx, conv, creds, in)
	}
	if err := aiCheckFile(conv, in); err != nil {
		return err.Error(), true
	}
	switch name {
	case aiReadFile:
		return h.readFile(ctx, conv, creds, in)
	case aiEditFile:
		return h.editFile(ctx, conv, creds, in)
	case aiReadArchive:
		return h.readArchive(ctx, conv, creds, in)
	}
	return h.storeFile(ctx, conv, creds, in, in.Content, fmt.Sprintf("Wrote %d bytes to %s", len(in.Content), in.Path))
}

func aiCheckFile(conv aiConversation, in aiFileInput) error {
	if !strings.HasPrefix(in.Path, "/") {
		return errors.New("file_path must be an absolute path inside the server's data volume")
	}
	if conv.Repository != "" {
		if in.Server != "" {
			return fmt.Errorf("this conversation is limited to repository %s", conv.Repository)
		}
		return nil
	}
	return aiCheckServer(conv, in)
}

func aiCheckServer(conv aiConversation, in aiFileInput) error {
	if conv.Repository != "" {
		return fmt.Errorf("shell tools are not available in repository %s", conv.Repository)
	}
	if conv.Server == "" && (!dnsLabelRE.MatchString(in.Server) || in.Namespace == "") {
		return errors.New("server and namespace are required in this conversation")
	}
	if conv.Server != "" && in.Server != "" && in.Server != conv.Server {
		return fmt.Errorf("this conversation is limited to server %s", conv.Server)
	}
	return nil
}

type aiShellResult struct {
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	ExitCode int    `json:"exitCode"`
}

func (h *aiHandler) shell(ctx context.Context, conv aiConversation, creds aiCreds, in aiFileInput) (string, bool) {
	if in.Background {
		return h.startJob(ctx, conv, creds, in)
	}
	out, failure := h.runShell(ctx, conv, creds, in, in.Command, in.Timeout)
	if failure != "" {
		return failure, true
	}
	return aiShellOutput(out.Stdout, out.Stderr, out.ExitCode), out.ExitCode != 0
}

func (h *aiHandler) runShell(ctx context.Context, conv aiConversation, creds aiCreds, in aiFileInput, command string, timeout int) (aiShellResult, string) {
	if err := aiCheckServer(conv, in); err != nil {
		return aiShellResult{}, err.Error()
	}
	call := aiFileCall(conv, http.MethodPost, "", in)
	call.Path = "/servers/" + cmp.Or(conv.Server, in.Server) + "/shell"
	delete(call.Query, "path")
	body, err := json.Marshal(map[string]any{"command": command, "timeoutSeconds": timeout})
	if err != nil {
		return aiShellResult{}, "Invalid shell input: " + err.Error()
	}
	status, data := h.request(ctx, conv, creds, call, body, "application/json")
	if status != http.StatusOK {
		return aiShellResult{}, fmt.Sprintf("HTTP %d\n%s", status, aiResultText(data))
	}
	var out aiShellResult
	if err := json.Unmarshal(data, &out); err != nil {
		return aiShellResult{}, "Invalid shell response: " + err.Error()
	}
	return out, ""
}

func aiShellOutput(stdout, stderr string, exitCode int) string {
	var b strings.Builder
	fmt.Fprintf(&b, "exit %d\n%s", exitCode, stdout)
	if stderr != "" {
		b.WriteString("\n[stderr]\n" + stderr)
	}
	return b.String()
}

func (h *aiHandler) fileCall(ctx context.Context, conv aiConversation, creds aiCreds, method, op string, in aiFileInput, body []byte) (int, []byte) {
	return h.request(ctx, conv, creds, aiFileCall(conv, method, op, in), body, "application/octet-stream")
}

func aiFileCall(conv aiConversation, method, op string, in aiFileInput) aiToolInput {
	call := aiToolInput{Method: method, Path: "/servers/" + cmp.Or(conv.Server, in.Server) + "/files/" + op, Query: map[string]string{"path": in.Path}}
	if conv.Repository != "" {
		call.Path = "/repositories/" + conv.Repository + "/files/" + op
	} else if conv.Server == "" {
		call.Query["namespace"] = in.Namespace
		if in.Cluster != "" {
			call.Query["cluster"] = in.Cluster
		}
	}
	return call
}

func (h *aiHandler) readArchive(ctx context.Context, conv aiConversation, creds aiCreds, in aiFileInput) (string, bool) {
	dir := in
	dir.Path = path.Dir(in.Path)
	status, data := h.fileCall(ctx, conv, creds, http.MethodGet, "list", dir, nil)
	if status != http.StatusOK {
		return fmt.Sprintf("HTTP %d\n%s", status, aiResultText(data)), true
	}
	var entries []aiListEntry
	if err := json.Unmarshal(data, &entries); err != nil {
		return "Could not list " + dir.Path + ": " + err.Error(), true
	}
	index := slices.IndexFunc(entries, func(entry aiListEntry) bool { return entry.Name == path.Base(in.Path) && !entry.Dir })
	if index < 0 {
		return in.Path + " was not found", true
	}
	target, err := h.authorize(ctx, conv, creds, http.MethodGet, aiFileCall(conv, http.MethodGet, "read", in))
	if err != nil {
		return err.Error(), true
	}
	status, data = h.call(ctx, creds, http.MethodGet, strings.Replace(target, "/files/read", "/files/download", 1), nil, "")
	if status != http.StatusOK {
		return fmt.Sprintf("HTTP %d\n%s", status, aiResultText(data)), true
	}
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return fmt.Sprintf("%s is not a jar or zip archive: %v", in.Path, err), true
	}
	if in.Entry == "" {
		return aiArchiveListing(archive), false
	}
	file, err := archive.Open(strings.TrimPrefix(in.Entry, "/"))
	if err != nil {
		return fmt.Sprintf("%s has no entry %s", in.Path, in.Entry), true
	}
	defer func() { _ = file.Close() }()
	content, err := io.ReadAll(file)
	switch {
	case err != nil:
		return fmt.Sprintf("Could not read %s: %v", in.Entry, err), true
	case !utf8.Valid(content):
		return fmt.Sprintf("%s is a binary entry (%d bytes)", in.Entry, len(content)), true
	}
	return aiNumbered(string(content), in.Offset, in.Limit), false
}

type aiListEntry struct {
	Name string `json:"name"`
	Dir  bool   `json:"dir"`
}

func aiArchiveListing(archive *zip.Reader) string {
	var b strings.Builder
	classes := 0
	for _, file := range archive.File {
		switch {
		case file.FileInfo().IsDir():
		case strings.HasSuffix(file.Name, ".class"):
			classes++
		default:
			fmt.Fprintf(&b, "%s\t%d bytes\n", file.Name, file.UncompressedSize64)
		}
	}
	fmt.Fprintf(&b, "(%d .class files not listed)", classes)
	return b.String()
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
		limit = total
	}
	limit = min(limit, total)
	if start > total {
		return fmt.Sprintf("%d lines; offset %d is past the end", total, start)
	}
	end := min(start+limit-1, total)
	var b strings.Builder
	for i := start; i <= end; i++ {
		fmt.Fprintf(&b, "%6d\t%s\n", i, lines[i-1])
	}
	if end < total {
		fmt.Fprintf(&b, "(lines %d-%d of %d; continue with offset=%d)", start, end, total, end+1)
	}
	return b.String()
}
