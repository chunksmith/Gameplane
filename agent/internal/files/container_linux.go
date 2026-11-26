package files

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"

	"golang.org/x/sys/unix"
)

var errNoGameProcess = errors.New("game process not found")

func gameDir(proc, dataRoot string) (string, error) {
	var self, data unix.Stat_t
	if err := unix.Stat(filepath.Join(proc, "self", "root"), &self); err != nil {
		return "", fmt.Errorf("stat own root: %w", err)
	}
	if err := unix.Stat(dataRoot, &data); err != nil {
		return "", fmt.Errorf("stat data root: %w", err)
	}
	entries, err := os.ReadDir(proc)
	if err != nil {
		return "", fmt.Errorf("read %s: %w", proc, err)
	}
	var pids []int
	for _, entry := range entries {
		if pid, err := strconv.Atoi(entry.Name()); err == nil {
			pids = append(pids, pid)
		}
	}
	slices.Sort(pids)
	for _, pid := range pids {
		base := filepath.Join(proc, strconv.Itoa(pid))
		var root, mount unix.Stat_t
		if unix.Stat(filepath.Join(base, "root"), &root) != nil || sameInode(root, self) {
			continue
		}
		if unix.Stat(filepath.Join(base, "root", dataRoot), &mount) == nil && sameInode(mount, data) {
			return filepath.Join(base, "cwd"), nil
		}
	}
	return "", errNoGameProcess
}

func sameInode(a, b unix.Stat_t) bool {
	return a.Dev == b.Dev && a.Ino == b.Ino
}
