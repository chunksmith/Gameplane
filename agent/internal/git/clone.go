package git

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"

	"github.com/GameplanePanel/gameplane/agent/internal/httpjson"
)

const (
	cloneDir   = ".gameplane-clone"
	lostFound  = "lost+found"
	cloneIdle  = "idle"
	cloneRun   = "running"
	cloneDone  = "done"
	cloneFault = "failed"
)

var progressPattern = regexp.MustCompile(`^(Receiving objects|Resolving deltas):\s+(\d+)%`)

type cloneState struct {
	State    string    `json:"state"`
	Progress int       `json:"progress"`
	Error    *gitError `json:"error,omitempty"`
}

func (h *handler) cloneStatus(w http.ResponseWriter, _ *http.Request) {
	h.cloneMu.Lock()
	defer h.cloneMu.Unlock()
	httpjson.Write(w, http.StatusOK, h.clone)
}

func (h *handler) setClone(state cloneState) {
	h.cloneMu.Lock()
	defer h.cloneMu.Unlock()
	h.clone = state
}

func (h *handler) startClone(w http.ResponseWriter, req *http.Request) {
	c := &call{h: h, req: req, token: req.Header.Get(tokenHeader)}
	var body struct {
		URL    string `json:"url"`
		Branch string `json:"branch"`
		Wipe   bool   `json:"wipe"`
	}
	if err := c.decode(&body); err != nil {
		writeError(w, c.wrap(err))
		return
	}
	if c.token == "" {
		writeError(w, errTokenRequired)
		return
	}
	if body.Branch != "" && !validRef(body.Branch) {
		writeError(w, badRequest("invalid branch name"))
		return
	}
	if err := h.checkRemote(req.Context(), body.URL); err != nil {
		writeError(w, c.wrap(err))
		return
	}
	if !h.mu.TryLock() {
		writeError(w, errBusy)
		return
	}
	if err := h.prepareClone(body.Wipe); err != nil {
		h.mu.Unlock()
		writeError(w, c.wrap(err))
		return
	}
	h.setClone(cloneState{State: cloneRun})
	ctx, cancel := context.WithTimeout(context.WithoutCancel(req.Context()), cloneTimeout)
	c.ctx = ctx
	c.progress = h.cloneProgress
	go func() {
		defer h.mu.Unlock()
		defer cancel()
		if err := c.clone(body.URL, body.Branch); err != nil {
			h.setClone(cloneState{State: cloneFault, Error: c.wrap(err)})
			return
		}
		h.setClone(cloneState{State: cloneDone, Progress: 100})
	}()
	httpjson.Write(w, http.StatusAccepted, cloneState{State: cloneRun})
}

func (h *handler) prepareClone(wipe bool) error {
	entries, err := os.ReadDir(h.dir)
	if err != nil {
		return fmt.Errorf("read working copy: %w", err)
	}
	for _, entry := range entries {
		if entry.Name() == lostFound {
			continue
		}
		if !wipe && entry.Name() != cloneDir {
			return fail(http.StatusConflict, "not_empty", "the working copy is not empty")
		}
		if err := os.RemoveAll(filepath.Join(h.dir, entry.Name())); err != nil {
			return fmt.Errorf("wipe working copy: %w", err)
		}
	}
	return nil
}

func (h *handler) cloneProgress(line string) {
	match := progressPattern.FindStringSubmatch(line)
	if match == nil {
		return
	}
	percent, err := strconv.Atoi(match[2])
	if err != nil {
		return
	}
	progress := percent * 9 / 10
	if match[1] == "Resolving deltas" {
		progress = 90 + percent/10
	}
	h.setClone(cloneState{State: cloneRun, Progress: progress})
}

func (c *call) clone(url, branch string) error {
	args := []string{"clone", "--progress", "--no-recurse-submodules"}
	if branch != "" {
		args = append(args, "--branch", branch)
	}
	if err := c.run(true, nil, io.Discard, append(args, "--", url, cloneDir)...); err != nil {
		return err
	}
	staging := filepath.Join(c.h.dir, cloneDir)
	entries, err := os.ReadDir(staging)
	if err != nil {
		return fmt.Errorf("read clone: %w", err)
	}
	for _, entry := range entries {
		if err := os.Rename(filepath.Join(staging, entry.Name()), filepath.Join(c.h.dir, entry.Name())); err != nil {
			return fmt.Errorf("move clone: %w", err)
		}
	}
	if err := os.Remove(staging); err != nil {
		return fmt.Errorf("remove clone staging: %w", err)
	}
	return nil
}
