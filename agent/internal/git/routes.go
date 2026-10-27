package git

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
)

type change struct {
	Path      string `json:"path"`
	OldPath   string `json:"oldPath,omitempty"`
	State     string `json:"state"`
	Staged    bool   `json:"staged"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
}

type status struct {
	Branch   string   `json:"branch"`
	Head     *string  `json:"head"`
	Upstream *string  `json:"upstream"`
	Ahead    int      `json:"ahead"`
	Behind   int      `json:"behind"`
	Changes  []change `json:"changes"`
}

type commit struct {
	SHA     string  `json:"sha"`
	Subject string  `json:"subject"`
	Body    string  `json:"body"`
	Author  string  `json:"author"`
	Login   *string `json:"login"`
	Time    string  `json:"time"`
	Pushed  bool    `json:"pushed"`
}

type branch struct {
	Name     string  `json:"name"`
	Current  bool    `json:"current"`
	Upstream *string `json:"upstream"`
	Ahead    int     `json:"ahead"`
	Behind   int     `json:"behind"`
}

const logFormat = "--format=%H%x1f%s%x1f%b%x1f%an%x1f%ae%x1f%aI"

var (
	shaPattern     = regexp.MustCompile(`^[0-9a-f]{4,64}$`)
	noreplyPattern = regexp.MustCompile(`^\d+\+([^@]+)@users\.noreply\.github\.com$`)
)

func (h *handler) status(c *call) (any, error) {
	return c.status()
}

func (c *call) status() (*status, error) {
	out, err := c.output("status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z")
	if err != nil {
		return nil, err
	}
	st := &status{Changes: []change{}}
	records := strings.Split(out, "\x00")
	for i := 0; i < len(records); i++ {
		record := records[i]
		switch {
		case strings.HasPrefix(record, "# branch.oid "):
			if oid := strings.TrimPrefix(record, "# branch.oid "); oid != "(initial)" {
				st.Head = &oid
			}
		case strings.HasPrefix(record, "# branch.head "):
			st.Branch = strings.TrimPrefix(record, "# branch.head ")
		case strings.HasPrefix(record, "# branch.upstream "):
			upstream := strings.TrimPrefix(record, "# branch.upstream ")
			st.Upstream = &upstream
		case strings.HasPrefix(record, "# branch.ab "):
			_, _ = fmt.Sscanf(strings.TrimPrefix(record, "# branch.ab "), "+%d -%d", &st.Ahead, &st.Behind)
		case strings.HasPrefix(record, "1 "):
			if fields := strings.SplitN(record, " ", 9); len(fields) == 9 {
				st.add(fields[1], fields[8], "")
			}
		case strings.HasPrefix(record, "2 ") && i+1 < len(records):
			i++
			if fields := strings.SplitN(record, " ", 10); len(fields) == 10 {
				st.add(fields[1], fields[9], records[i])
			}
		case strings.HasPrefix(record, "u "):
			if fields := strings.SplitN(record, " ", 11); len(fields) == 11 {
				st.Changes = append(st.Changes, change{Path: fields[10], State: "M"})
			}
		case strings.HasPrefix(record, "? "):
			st.Changes = append(st.Changes, change{Path: strings.TrimPrefix(record, "? "), State: "U"})
		}
	}
	staged, err := c.numstat(true)
	if err != nil {
		return nil, err
	}
	unstaged, err := c.numstat(false)
	if err != nil {
		return nil, err
	}
	for i := range st.Changes {
		counts := unstaged[st.Changes[i].Path]
		if st.Changes[i].Staged {
			counts = staged[st.Changes[i].Path]
		}
		st.Changes[i].Additions, st.Changes[i].Deletions = counts[0], counts[1]
	}
	return st, nil
}

func (s *status) add(xy, path, oldPath string) {
	for i, staged := range []bool{true, false} {
		if xy[i] == '.' {
			continue
		}
		entry := change{Path: path, State: stateOf(xy[i]), Staged: staged}
		if entry.State == "R" {
			entry.OldPath = oldPath
		}
		s.Changes = append(s.Changes, entry)
	}
}

func stateOf(letter byte) string {
	switch letter {
	case 'A', 'C':
		return "A"
	case 'D':
		return "D"
	case 'R':
		return "R"
	default:
		return "M"
	}
}

func (c *call) numstat(cached bool) (map[string][2]int, error) {
	args := []string{"diff", "--numstat", "-z"}
	if cached {
		args = append(args, "--cached")
	}
	out, err := c.output(args...)
	if err != nil {
		return nil, err
	}
	counts := map[string][2]int{}
	fields := strings.Split(out, "\x00")
	for i := 0; i < len(fields); i++ {
		parts := strings.SplitN(fields[i], "\t", 3)
		if len(parts) != 3 {
			continue
		}
		path := parts[2]
		if path == "" && i+2 < len(fields) {
			path = fields[i+2]
			i += 2
		}
		additions, _ := strconv.Atoi(parts[0])
		deletions, _ := strconv.Atoi(parts[1])
		counts[path] = [2]int{additions, deletions}
	}
	return counts, nil
}

func pathspec(path string) (string, error) {
	path = strings.TrimPrefix(path, "/")
	if !filepath.IsLocal(path) {
		return "", badRequest("invalid path")
	}
	if strings.Split(filepath.ToSlash(filepath.Clean(path)), "/")[0] == ".git" {
		return "", errGitDir
	}
	return ":(literal)" + path, nil
}

func (c *call) capped(args ...string) (diffText, error) {
	out := &cappedBuffer{max: maxDiffBytes}
	if err := c.run(false, nil, out, args...); err != nil {
		return "", err
	}
	if out.over {
		return "", fail(http.StatusRequestEntityTooLarge, "too_large", "diff exceeds 5 MiB")
	}
	return diffText(out.String()), nil
}

func (h *handler) diff(c *call) (any, error) {
	query := c.req.URL.Query()
	args := []string{"diff", "--no-color", "--no-ext-diff"}
	if query.Get("staged") == "true" {
		args = append(args, "--cached")
	}
	if path := query.Get("path"); path != "" {
		spec, err := pathspec(path)
		if err != nil {
			return nil, err
		}
		args = append(args, "--", spec)
	}
	return c.capped(args...)
}

func (c *call) paths() (bool, []string, error) {
	var body struct {
		Paths json.RawMessage `json:"paths"`
	}
	if err := c.decode(&body); err != nil {
		return false, nil, err
	}
	if string(body.Paths) == `"all"` {
		return true, nil, nil
	}
	var paths []string
	if err := json.Unmarshal(body.Paths, &paths); err != nil || len(paths) == 0 {
		return false, nil, badRequest(`paths must be "all" or a non-empty list`)
	}
	specs := make([]string, 0, len(paths))
	for _, path := range paths {
		spec, err := pathspec(path)
		if err != nil {
			return false, nil, err
		}
		specs = append(specs, spec)
	}
	return false, specs, nil
}

func (c *call) withPaths(all bool, specs []string, args ...string) []string {
	if all {
		return args
	}
	return append(append(args, "--"), specs...)
}

func (h *handler) stage(c *call) (any, error) {
	all, specs, err := c.paths()
	if err != nil {
		return nil, err
	}
	if _, err = c.output(c.withPaths(all, specs, "add", "-A")...); err != nil {
		return nil, err
	}
	return c.status()
}

func (h *handler) unstage(c *call) (any, error) {
	all, specs, err := c.paths()
	if err != nil {
		return nil, err
	}
	args := c.withPaths(all, specs, "reset", "-q")
	if !c.succeeds("rev-parse", "-q", "--verify", "HEAD") {
		if all {
			specs = []string{"."}
		}
		args = append([]string{"rm", "-r", "-q", "--cached", "--ignore-unmatch", "--"}, specs...)
	}
	if _, err = c.output(args...); err != nil {
		return nil, err
	}
	return c.status()
}

func (h *handler) discard(c *call) (any, error) {
	all, specs, err := c.paths()
	if err != nil {
		return nil, err
	}
	if all {
		specs = []string{"."}
	}
	tracked, err := c.output(append([]string{"ls-files", "-z", "--"}, specs...)...)
	if err != nil {
		return nil, err
	}
	restore := specs
	if !all {
		restore = nil
		for _, path := range strings.FieldsFunc(tracked, isNUL) {
			restore = append(restore, ":(literal)"+path)
		}
	}
	if tracked != "" {
		if _, err = c.output(append([]string{"restore", "--worktree", "--"}, restore...)...); err != nil {
			return nil, err
		}
	}
	if _, err = c.output(append([]string{"clean", "-f", "-d", "-q", "--"}, specs...)...); err != nil {
		return nil, err
	}
	return c.status()
}

func (c *call) author() error {
	name := strings.TrimSpace(c.req.Header.Get(authorNameHeader))
	email := strings.TrimSpace(c.req.Header.Get(authorEmailHeader))
	if name == "" || email == "" {
		return badRequest("commit author headers are required")
	}
	c.env = append(c.env,
		"GIT_AUTHOR_NAME="+name, "GIT_AUTHOR_EMAIL="+email,
		"GIT_COMMITTER_NAME="+name, "GIT_COMMITTER_EMAIL="+email)
	return nil
}

func (h *handler) commit(c *call) (any, error) {
	var body struct {
		Summary     string `json:"summary"`
		Description string `json:"description"`
		Push        bool   `json:"push"`
	}
	if err := c.decode(&body); err != nil {
		return nil, err
	}
	message := strings.TrimSpace(body.Summary)
	if message == "" {
		return nil, badRequest("summary is required")
	}
	if err := c.author(); err != nil {
		return nil, err
	}
	if body.Push && c.token == "" {
		return nil, errTokenRequired
	}
	if description := strings.TrimSpace(body.Description); description != "" {
		message += "\n\n" + description
	}
	if err := c.run(false, strings.NewReader(message), io.Discard, "commit", "-q", "-F", "-"); err != nil {
		return nil, err
	}
	created, err := c.commit("HEAD")
	if err != nil || !body.Push {
		return map[string]any{"commit": created, "pushed": false}, err
	}
	if err = c.pushHead(true); err != nil {
		pushErr := *c.wrap(err)
		pushErr.Commit = created
		return nil, &pushErr
	}
	created.Pushed = true
	return map[string]any{"commit": created, "pushed": true}, nil
}

func (c *call) unpushed() (map[string]bool, error) {
	out, err := c.output("rev-list", "--branches", "--not", "--remotes")
	if err != nil {
		return nil, err
	}
	shas := map[string]bool{}
	for _, sha := range strings.Fields(out) {
		shas[sha] = true
	}
	return shas, nil
}

func (c *call) commits(args ...string) ([]commit, error) {
	out, err := c.output(append([]string{"log", "-z", logFormat}, args...)...)
	if err != nil {
		return nil, err
	}
	unpushed, err := c.unpushed()
	if err != nil {
		return nil, err
	}
	list := []commit{}
	for _, record := range strings.Split(out, "\x00") {
		fields := strings.Split(record, "\x1f")
		if len(fields) != 6 {
			continue
		}
		entry := commit{
			SHA:     fields[0],
			Subject: fields[1],
			Body:    strings.TrimSpace(fields[2]),
			Author:  fields[3],
			Time:    fields[5],
			Pushed:  !unpushed[fields[0]],
		}
		if match := noreplyPattern.FindStringSubmatch(fields[4]); match != nil {
			entry.Login = &match[1]
		}
		list = append(list, entry)
	}
	return list, nil
}

func (c *call) commit(rev string) (*commit, error) {
	list, err := c.commits("-n", "1", rev)
	if err != nil {
		return nil, err
	}
	if len(list) == 0 {
		return nil, fail(http.StatusNotFound, "not_found", "commit not found")
	}
	return &list[0], nil
}

func (h *handler) log(c *call) (any, error) {
	query := c.req.URL.Query()
	limit := 50
	if n, err := strconv.Atoi(query.Get("limit")); err == nil && n > 0 && n <= 200 {
		limit = n
	}
	start := query.Get("cursor")
	if start == "" {
		start = query.Get("ref")
	}
	if start == "" {
		start = "HEAD"
	}
	if strings.HasPrefix(start, "-") {
		return nil, badRequest("invalid ref")
	}
	result := map[string]any{"commits": []commit{}, "next": nil}
	if start == "HEAD" && !c.succeeds("rev-parse", "-q", "--verify", "HEAD") {
		return result, nil
	}
	list, err := c.commits("-n", strconv.Itoa(limit+1), start)
	if err != nil {
		return nil, err
	}
	if len(list) > limit {
		result["next"] = list[limit].SHA
		list = list[:limit]
	}
	result["commits"] = list
	return result, nil
}

func (h *handler) show(c *call) (any, error) {
	sha := chi.URLParam(c.req, "sha")
	if !shaPattern.MatchString(sha) {
		return nil, badRequest("invalid sha")
	}
	found, err := c.commit(sha)
	if err != nil {
		return nil, err
	}
	diff, err := c.capped("show", "--format=", "--no-color", "--no-ext-diff", found.SHA)
	if err != nil {
		return nil, err
	}
	return map[string]any{"commit": found, "diff": string(diff)}, nil
}

func (c *call) conflicted() []string {
	out, err := c.output("diff", "--name-only", "--diff-filter=U", "-z")
	if err != nil {
		return nil
	}
	return strings.FieldsFunc(out, isNUL)
}

func isNUL(r rune) bool {
	return r == 0
}

func conflict(files []string, output string) *gitError {
	err := fail(http.StatusConflict, "conflict", "the operation hit conflicts and was aborted")
	err.Files = files
	err.Output = output
	return err
}

func (h *handler) revert(c *call) (any, error) {
	var body struct {
		SHA string `json:"sha"`
	}
	if err := c.decode(&body); err != nil {
		return nil, err
	}
	if !shaPattern.MatchString(body.SHA) {
		return nil, badRequest("invalid sha")
	}
	if err := c.author(); err != nil {
		return nil, err
	}
	if err := c.run(false, nil, io.Discard, "revert", "--no-edit", body.SHA); err != nil {
		if !c.succeeds("rev-parse", "-q", "--verify", "REVERT_HEAD") {
			return nil, err
		}
		files := c.conflicted()
		if _, abortErr := c.output("revert", "--abort"); abortErr != nil {
			return nil, abortErr
		}
		return nil, conflict(files, c.wrap(err).Output)
	}
	created, err := c.commit("HEAD")
	if err != nil {
		return nil, err
	}
	return map[string]any{"commit": created}, nil
}

func (h *handler) undo(c *call) (any, error) {
	head, err := c.output("rev-parse", "HEAD")
	if err != nil {
		return nil, err
	}
	unpushed, err := c.unpushed()
	if err != nil {
		return nil, err
	}
	if !unpushed[strings.TrimSpace(head)] {
		return nil, fail(http.StatusConflict, "already_pushed", "the last commit is already pushed")
	}
	args := []string{"reset", "-q", "--soft", "HEAD~1"}
	if !c.succeeds("rev-parse", "-q", "--verify", "HEAD~1") {
		args = []string{"update-ref", "-d", "HEAD"}
	}
	if _, err = c.output(args...); err != nil {
		return nil, err
	}
	return c.status()
}

func (c *call) branches() ([]branch, error) {
	out, err := c.output("for-each-ref",
		"--format=%(refname)%00%(refname:short)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(HEAD)",
		"refs/heads", "refs/remotes")
	if err != nil {
		return nil, err
	}
	list := []branch{}
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Split(line, "\x00")
		if len(fields) != 5 || (strings.HasPrefix(fields[0], "refs/remotes/") && strings.HasSuffix(fields[0], "/HEAD")) {
			continue
		}
		entry := branch{Name: fields[1], Current: fields[4] == "*"}
		if fields[2] != "" {
			entry.Upstream = &fields[2]
		}
		for _, part := range strings.Split(fields[3], ", ") {
			_, _ = fmt.Sscanf(part, "ahead %d", &entry.Ahead)
			_, _ = fmt.Sscanf(part, "behind %d", &entry.Behind)
		}
		list = append(list, entry)
	}
	return list, nil
}

func (h *handler) branches(c *call) (any, error) {
	return c.branches()
}

func validRef(name string) bool {
	return name != "" && !strings.HasPrefix(name, "-")
}

func (h *handler) createBranch(c *call) (any, error) {
	var body struct {
		Name     string `json:"name"`
		From     string `json:"from"`
		Checkout bool   `json:"checkout"`
	}
	if err := c.decode(&body); err != nil {
		return nil, err
	}
	if body.From == "" {
		body.From = "HEAD"
	}
	if !validRef(body.Name) || !validRef(body.From) || !c.succeeds("check-ref-format", "--branch", body.Name) {
		return nil, badRequest("invalid branch name")
	}
	args := []string{"branch", "--no-track", body.Name, body.From}
	if body.Checkout {
		args = []string{"switch", "-q", "-c", body.Name, "--no-track", body.From}
	}
	if _, err := c.output(args...); err != nil {
		return nil, err
	}
	list, err := c.branches()
	if err != nil {
		return nil, err
	}
	for _, entry := range list {
		if entry.Name == body.Name {
			return entry, nil
		}
	}
	return nil, fail(http.StatusNotFound, "not_found", "branch not found")
}

func (h *handler) checkout(c *call) (any, error) {
	var body struct {
		Branch string `json:"branch"`
	}
	if err := c.decode(&body); err != nil {
		return nil, err
	}
	name := strings.TrimPrefix(body.Branch, "origin/")
	if !validRef(name) {
		return nil, badRequest("invalid branch name")
	}
	dirty, err := c.output("status", "--porcelain", "--untracked-files=no")
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(dirty) != "" {
		return nil, fail(http.StatusConflict, "dirty", "commit or discard changes before switching branches")
	}
	if _, err = c.output("switch", "-q", name); err != nil {
		return nil, err
	}
	return c.status()
}

func (h *handler) fetch(c *call) (any, error) {
	if err := c.requireNetwork(); err != nil {
		return nil, err
	}
	if err := c.network("fetch", "--prune", "--no-recurse-submodules", "origin"); err != nil {
		return nil, err
	}
	return c.status()
}

func (h *handler) pull(c *call) (any, error) {
	if err := c.requireNetwork(); err != nil {
		return nil, err
	}
	_ = c.author()
	err := c.network("pull", "--rebase", "--autostash", "--no-recurse-submodules", "origin")
	if err != nil {
		if !c.rebasing() {
			return nil, err
		}
		files := c.conflicted()
		if _, abortErr := c.output("rebase", "--abort"); abortErr != nil {
			return nil, abortErr
		}
		return nil, conflict(files, c.wrap(err).Output)
	}
	return c.status()
}

func (c *call) rebasing() bool {
	root, err := os.OpenRoot(c.h.dir)
	if err != nil {
		return false
	}
	defer func() { _ = root.Close() }()
	for _, name := range []string{".git/rebase-merge", ".git/rebase-apply"} {
		if _, err := root.Stat(name); err == nil {
			return true
		}
	}
	return false
}

func (c *call) pushHead(setUpstream bool) error {
	if err := c.requireNetwork(); err != nil {
		return err
	}
	args := []string{"push", "--recurse-submodules=no"}
	if setUpstream {
		args = append(args, "--set-upstream")
	}
	err := c.network(append(args, "origin", "HEAD")...)
	if err == nil {
		return nil
	}
	if output := c.wrap(err).Output; strings.Contains(output, "[rejected]") {
		rejected := fail(http.StatusConflict, "push_rejected", "the remote has commits you do not have; pull first")
		rejected.Output = output
		return rejected
	}
	return err
}

func (h *handler) push(c *call) (any, error) {
	var body struct {
		SetUpstream bool `json:"setUpstream"`
	}
	if err := c.decode(&body); err != nil {
		return nil, err
	}
	if err := c.pushHead(body.SetUpstream); err != nil {
		return nil, err
	}
	return c.status()
}
