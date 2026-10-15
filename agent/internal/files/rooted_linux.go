package files

import (
	"archive/zip"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// This file holds every filesystem operation of the file browser. They all
// run relative to a directory descriptor opened on the data root: each path
// component is opened with openat(O_NOFOLLOW) so a symlink at any component is
// refused instead of followed, and reads, writes, creates and deletes go
// through the descriptors they obtained rather than re-opening a path string.
// A directory or file swapped for a symlink after the request was validated
// therefore cannot redirect the operation outside the root.

const (
	// dirFlags opens a directory component: no symlink at the last component,
	// must be a directory.
	dirFlags = unix.O_RDONLY | unix.O_DIRECTORY | unix.O_NOFOLLOW | unix.O_CLOEXEC
	// fileFlags opens a final component for reading: no symlink.
	fileFlags = unix.O_RDONLY | unix.O_NOFOLLOW | unix.O_CLOEXEC
)

// errLinkTraversal is returned when a path component is a symlink. It wraps
// errPathOutOfRoot so it is echoed to the client as a 400 and the body still
// contains "escapes root".
var errLinkTraversal = fmt.Errorf("%w (symbolic link in path)", errPathOutOfRoot)

// errBadPath marks an ancestor component that is not a directory. It is not
// echoed (generic 400 "bad request"), matching the old EvalSymlinks ENOTDIR
// behaviour.
var errBadPath = errors.New("path component is not a directory")

// fire invokes the test seam, if any.
func (h *handler) fire(stage string, parents []string, name string) {
	if h.beforeOpen == nil {
		return
	}
	h.beforeOpen(stage, strings.Join(parents, "/"), name)
}

// openat is unix.Openat retried on EINTR.
func openat(dirFD int, name string, flags int, mode uint32) (int, error) {
	for {
		fd, err := unix.Openat(dirFD, name, flags, mode)
		if !errors.Is(err, unix.EINTR) {
			return fd, err
		}
	}
}

// closeFD closes a descriptor, ignoring the error (read-only directory
// descriptors; there is nothing useful to do with it).
func closeFD(fd int) {
	_ = unix.Close(fd)
}

// fileFromFD wraps fd, returned by a successful openat, in an *os.File. A
// successful openat never yields a negative descriptor; the guard keeps the
// int to uintptr conversion provably in range (gosec G115).
func fileFromFD(fd int, name string) (*os.File, error) {
	if fd < 0 {
		return nil, fmt.Errorf("open %q: %w", name, unix.EBADF)
	}
	return os.NewFile(uintptr(fd), name), nil
}

// openRoot opens the configured data root. The root path is operator-supplied
// and trusted (it may legitimately be reached through a symlink), so it is the
// only component that is followed.
func openRoot(root string) (int, error) {
	fd, err := openat(unix.AT_FDCWD, root, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, fmt.Errorf("open root: %w", err)
	}
	return fd, nil
}

// relComponents returns the components of abs below root (nil for the root
// itself) or errPathOutOfRoot if abs is not below root.
func relComponents(root, abs string) ([]string, error) {
	rel, err := filepath.Rel(root, abs)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return nil, errPathOutOfRoot
	}
	if rel == "." {
		return nil, nil
	}
	return strings.Split(rel, string(os.PathSeparator)), nil
}

// parentsOf returns all but the last of comps.
func parentsOf(comps []string) []string {
	if len(comps) == 0 {
		return nil
	}
	return comps[:len(comps)-1]
}

// entryPath is the client-visible path of name inside the directory comps.
func entryPath(comps []string, name string) string {
	return "/" + strings.Join(append(slices.Clone(comps), name), "/")
}

// fileModeFromStat converts a stat(2) mode word to an os.FileMode, matching
// what os.Lstat reports.
func fileModeFromStat(m uint32) os.FileMode {
	mode := os.FileMode(m & 0o777)
	switch m & unix.S_IFMT {
	case unix.S_IFBLK:
		mode |= os.ModeDevice
	case unix.S_IFCHR:
		mode |= os.ModeDevice | os.ModeCharDevice
	case unix.S_IFDIR:
		mode |= os.ModeDir
	case unix.S_IFIFO:
		mode |= os.ModeNamedPipe
	case unix.S_IFLNK:
		mode |= os.ModeSymlink
	case unix.S_IFSOCK:
		mode |= os.ModeSocket
	}
	if m&unix.S_ISGID != 0 {
		mode |= os.ModeSetgid
	}
	if m&unix.S_ISUID != 0 {
		mode |= os.ModeSetuid
	}
	if m&unix.S_ISVTX != 0 {
		mode |= os.ModeSticky
	}
	return mode
}

// symlinkError builds the error for a refused symlink at name inside dirFD
// (reached through parents). The link is never followed; its target is read
// only to pick the message: a target lexically below a dot-prefixed component
// is reported as errDotfile (so the response matches a direct request for that
// dotfile), anything else as errLinkTraversal.
func (h *handler) symlinkError(dirFD int, parents []string, name string) error {
	buf := make([]byte, 4096)
	n, err := unix.Readlinkat(dirFD, name, buf)
	if err != nil || n <= 0 {
		return errLinkTraversal
	}
	target := string(buf[:n])
	var abs string
	if filepath.IsAbs(target) {
		abs = filepath.Clean(target)
	} else {
		abs = filepath.Join(h.root, filepath.Join(parents...), target)
	}
	rel, err := filepath.Rel(h.root, abs)
	if err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator)) &&
		hasDotComponent(filepath.ToSlash(rel)) {
		return errDotfile
	}
	return errLinkTraversal
}

// openChild opens name inside dirFD with the given flags (dirFlags or
// fileFlags, both O_NOFOLLOW). A symlink at name is refused with a
// symlinkError; Linux reports it as ELOOP or, together with O_DIRECTORY, as
// ENOTDIR, so both are disambiguated with an lstat-style fstatat.
func (h *handler) openChild(dirFD int, parents []string, name string, flags int) (int, error) {
	h.fire("open", parents, name)
	fd, err := openat(dirFD, name, flags, 0)
	if err == nil {
		return fd, nil
	}
	if errors.Is(err, unix.ELOOP) || errors.Is(err, unix.ENOTDIR) {
		var st unix.Stat_t
		if serr := unix.Fstatat(dirFD, name, &st, unix.AT_SYMLINK_NOFOLLOW); serr == nil && st.Mode&unix.S_IFMT == unix.S_IFLNK {
			return -1, h.symlinkError(dirFD, parents, name)
		}
	}
	return -1, fmt.Errorf("open %q: %w", name, err)
}

// walkDirs opens the directory comps below rootFD, one openat per component,
// and returns a new descriptor for it (the caller closes it; rootFD stays
// open). With create, missing directories are created with mkdirat. target
// says comps ends at the operation's own target (mkdir/upload), so ENOTDIR at
// the last component is a plain error instead of a bad ancestor.
func (h *handler) walkDirs(rootFD int, comps []string, create, target bool) (int, error) {
	cur, err := openat(rootFD, ".", dirFlags, 0)
	if err != nil {
		return -1, fmt.Errorf("open root dir: %w", err)
	}
	for i, name := range comps {
		next, oerr := h.openChild(cur, comps[:i], name, dirFlags)
		if errors.Is(oerr, unix.ENOENT) && create {
			merr := unix.Mkdirat(cur, name, dirMode)
			if merr != nil && !errors.Is(merr, unix.EEXIST) {
				closeFD(cur)
				return -1, fmt.Errorf("mkdir %q: %w", name, merr)
			}
			next, oerr = h.openChild(cur, comps[:i], name, dirFlags)
		}
		closeFD(cur)
		if oerr != nil {
			isTarget := target && i == len(comps)-1
			if errors.Is(oerr, unix.ENOTDIR) && !isTarget {
				return -1, fmt.Errorf("%w: %w", errBadPath, oerr)
			}
			return -1, oerr
		}
		cur = next
	}
	return cur, nil
}

// locate opens the directory that holds the last component of comps and
// returns it with that component's name. For the root itself (no components)
// it returns the root directory and an empty name.
func (h *handler) locate(rootFD int, comps []string, create bool) (int, string, error) {
	if len(comps) == 0 {
		fd, err := h.walkDirs(rootFD, nil, false, false)
		return fd, "", err
	}
	fd, err := h.walkDirs(rootFD, parentsOf(comps), create, false)
	return fd, comps[len(comps)-1], err
}

// dirNames lists the entry names of the directory open as fd, sorted. It
// reads through a fresh descriptor for the same directory so the caller's fd
// offset is untouched.
func dirNames(fd int) ([]string, error) {
	rd, err := openat(fd, ".", dirFlags, 0)
	if err != nil {
		return nil, fmt.Errorf("reopen directory: %w", err)
	}
	f, err := fileFromFD(rd, ".")
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	names, err := f.Readdirnames(-1)
	if err != nil {
		return nil, fmt.Errorf("read directory: %w", err)
	}
	slices.Sort(names)
	return names, nil
}

// listDir returns the visible (non-dot) entries of the directory comps.
func (h *handler) listDir(comps []string) ([]Entry, error) {
	rootFD, err := openRoot(h.root)
	if err != nil {
		return nil, err
	}
	defer closeFD(rootFD)
	parentFD, name, err := h.locate(rootFD, comps, false)
	if err != nil {
		return nil, err
	}
	defer closeFD(parentFD)
	dirFD := parentFD
	if name != "" {
		dirFD, err = h.openChild(parentFD, parentsOf(comps), name, dirFlags)
		if err != nil {
			return nil, err
		}
		defer closeFD(dirFD)
	}
	names, err := dirNames(dirFD)
	if err != nil {
		return nil, err
	}
	out := make([]Entry, 0, len(names))
	for _, n := range names {
		// Skip dot-prefixed entries (dotfiles and dot-directories).
		if strings.HasPrefix(n, ".") {
			continue
		}
		var st unix.Stat_t
		if unix.Fstatat(dirFD, n, &st, unix.AT_SYMLINK_NOFOLLOW) != nil {
			continue
		}
		mode := fileModeFromStat(st.Mode)
		out = append(out, Entry{
			Name:    n,
			Path:    entryPath(comps, n),
			Size:    st.Size,
			Mode:    mode.String(),
			Dir:     mode.IsDir(),
			ModTime: time.Unix(st.Mtim.Unix()).UTC().Format(time.RFC3339),
		})
	}
	return out, nil
}

// openFile opens the file (or directory) comps for reading without following
// a symlink at any component. The caller closes the returned file.
func (h *handler) openFile(comps []string) (*os.File, error) {
	rootFD, err := openRoot(h.root)
	if err != nil {
		return nil, err
	}
	defer closeFD(rootFD)
	parentFD, name, err := h.locate(rootFD, comps, false)
	if err != nil {
		return nil, err
	}
	defer closeFD(parentFD)
	if name == "" {
		name = "." // the root directory itself
	}
	fd, err := h.openChild(parentFD, parentsOf(comps), name, fileFlags)
	if err != nil {
		return nil, err
	}
	return fileFromFD(fd, name)
}

// makeDirs creates the directory comps (and any missing ancestors), the
// descriptor-relative equivalent of os.MkdirAll.
func (h *handler) makeDirs(comps []string) error {
	rootFD, err := openRoot(h.root)
	if err != nil {
		return err
	}
	defer closeFD(rootFD)
	fd, err := h.walkDirs(rootFD, comps, true, true)
	if err != nil {
		return err
	}
	closeFD(fd)
	return nil
}

// createTemp creates a fresh 0o600 temp file named prefix+random in dirFD,
// never following a symlink.
func createTemp(dirFD int, prefix string) (*os.File, string, error) {
	for range 16 {
		name := prefix + rand.Text()
		fd, err := openat(dirFD, name, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0o600)
		if err == nil {
			f, ferr := fileFromFD(fd, name)
			return f, name, ferr
		}
		if !errors.Is(err, unix.EEXIST) {
			return nil, "", fmt.Errorf("create temp file: %w", err)
		}
	}
	return nil, "", fmt.Errorf("create temp file: %w", unix.EEXIST)
}

// storeFile writes name inside dirFD atomically: fill streams the content
// into a temp file created in dirFD, which is chmodded, fsynced and renamed
// over name with renameat in the same directory. On any failure only the temp
// file is removed; an existing name is left untouched. renameat replaces a
// symlink that appears at name in the meantime instead of following it.
func (h *handler) storeFile(dirFD int, parents []string, name, prefix string, fill func(io.Writer) error) error {
	access, err := h.destAccess(dirFD, parents, name)
	if err != nil {
		return err
	}
	tmp, tmpName, err := createTemp(dirFD, prefix)
	if err != nil {
		return err
	}
	abort := func(cause error) error {
		_ = tmp.Close()
		_ = unix.Unlinkat(dirFD, tmpName, 0)
		return cause
	}
	if err = fill(tmp); err != nil {
		return abort(err)
	}
	if h.preserveAccess != nil {
		err = h.preserveAccess(tmp, access)
	} else {
		err = access.apply(tmp)
	}
	if err != nil {
		return abort(fmt.Errorf("%w: %w", errPreserveAccess, err))
	}
	if err = tmp.Sync(); err != nil {
		return abort(fmt.Errorf("sync %q: %w", name, err))
	}
	if err = tmp.Close(); err != nil {
		return abort(fmt.Errorf("close %q: %w", name, err))
	}
	h.fire("commit", parents, name)
	if !access.unchanged(dirFD, name) {
		return abort(fmt.Errorf("%w: destination changed during upload", errPreserveAccess))
	}
	if err = unix.Renameat(dirFD, tmpName, dirFD, name); err != nil {
		return abort(fmt.Errorf("rename %q: %w", name, err))
	}
	return nil
}

// storeIn opens the directory comps (creating missing ancestors when create is
// set) and stores name in it atomically via storeFile.
func (h *handler) storeIn(comps []string, name, prefix string, create bool, fill func(io.Writer) error) error {
	rootFD, err := openRoot(h.root)
	if err != nil {
		return err
	}
	defer closeFD(rootFD)
	dirFD, err := h.walkDirs(rootFD, comps, create, false)
	if err != nil {
		return err
	}
	defer closeFD(dirFD)
	return h.storeFile(dirFD, comps, name, prefix, fill)
}

// writeFile atomically writes the file comps, creating missing ancestors.
func (h *handler) writeFile(comps []string, fill func(io.Writer) error) error {
	if len(comps) == 0 {
		return fmt.Errorf("write root: %w", unix.EISDIR)
	}
	return h.storeIn(parentsOf(comps), comps[len(comps)-1], ".write-", true, fill)
}

// removeEntry removes the single entry name in dirFD like os.Remove: unlink,
// then rmdir. A symlink is removed as the link it is.
func removeEntry(dirFD int, name string) error {
	uerr := unix.Unlinkat(dirFD, name, 0)
	if uerr == nil {
		return nil
	}
	rerr := unix.Unlinkat(dirFD, name, unix.AT_REMOVEDIR)
	if rerr == nil {
		return nil
	}
	if errors.Is(rerr, unix.ENOTDIR) {
		return uerr
	}
	return rerr
}

// removePath deletes the entry comps. Non-recursive: unlink/rmdir of the one
// entry. Recursive: refuses (errDotfile) a tree containing dot-prefixed
// entries, then removes the tree through descriptors without following
// symlinks (they are unlinked as links).
func (h *handler) removePath(comps []string, recursive bool) error {
	rootFD, err := openRoot(h.root)
	if err != nil {
		return err
	}
	defer closeFD(rootFD)
	parentFD, name, err := h.locate(rootFD, comps, false)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			// A missing parent was a generic 400 before descriptors; keep it.
			return fmt.Errorf("%w: %w", errBadPath, err)
		}
		return err
	}
	defer closeFD(parentFD)
	parents := parentsOf(comps)
	if !recursive {
		h.fire("remove", parents, name)
		return removeEntry(parentFD, name)
	}
	if err = h.checkNoDotAt(parentFD, parents, name); err != nil {
		return err
	}
	return h.removeTree(parentFD, parents, name)
}

// checkNoDotAt returns errDotfile if the directory tree at name (inside dirFD)
// contains a dot-prefixed entry. Symlinks are not followed.
func (h *handler) checkNoDotAt(dirFD int, parents []string, name string) error {
	var st unix.Stat_t
	err := unix.Fstatat(dirFD, name, &st, unix.AT_SYMLINK_NOFOLLOW)
	if errors.Is(err, unix.ENOENT) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("stat %q: %w", name, err)
	}
	if st.Mode&unix.S_IFMT != unix.S_IFDIR {
		return nil
	}
	fd, err := h.openChild(dirFD, parents, name, dirFlags)
	if err != nil {
		return err
	}
	defer closeFD(fd)
	names, err := dirNames(fd)
	if err != nil {
		return err
	}
	here := append(slices.Clone(parents), name)
	for _, n := range names {
		if strings.HasPrefix(n, ".") {
			return errDotfile
		}
		if err = h.checkNoDotAt(fd, here, n); err != nil {
			return err
		}
	}
	return nil
}

// removeTree removes name inside dirFD, recursing into real directories only.
// A missing entry is not an error (os.RemoveAll semantics).
func (h *handler) removeTree(dirFD int, parents []string, name string) error {
	var st unix.Stat_t
	err := unix.Fstatat(dirFD, name, &st, unix.AT_SYMLINK_NOFOLLOW)
	if errors.Is(err, unix.ENOENT) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("stat %q: %w", name, err)
	}
	if st.Mode&unix.S_IFMT != unix.S_IFDIR {
		err = unix.Unlinkat(dirFD, name, 0)
		if err != nil && !errors.Is(err, unix.ENOENT) {
			return fmt.Errorf("remove %q: %w", name, err)
		}
		return nil
	}
	fd, err := h.openChild(dirFD, parents, name, dirFlags)
	if err != nil {
		return err
	}
	err = h.removeChildren(fd, append(slices.Clone(parents), name))
	closeFD(fd)
	if err != nil {
		return err
	}
	err = unix.Unlinkat(dirFD, name, unix.AT_REMOVEDIR)
	if err != nil && !errors.Is(err, unix.ENOENT) {
		return fmt.Errorf("remove %q: %w", name, err)
	}
	return nil
}

// removeChildren removes every entry of the directory open as fd. A
// dot-prefixed entry (created after the pre-check) stops the removal with
// errDotfile instead of being deleted.
func (h *handler) removeChildren(fd int, path []string) error {
	names, err := dirNames(fd)
	if err != nil {
		return err
	}
	for _, n := range names {
		if strings.HasPrefix(n, ".") {
			return errDotfile
		}
		if err = h.removeTree(fd, path, n); err != nil {
			return err
		}
	}
	return nil
}

var storedExtensions = []string{".7z", ".gz", ".jar", ".mca", ".png", ".rar", ".tgz", ".xz", ".zip", ".zst"}

func (h *handler) treeSize(ctx context.Context, comps []string) (int64, error) {
	rootFD, err := openRoot(h.root)
	if err != nil {
		return 0, err
	}
	defer closeFD(rootFD)
	fd, err := h.walkDirs(rootFD, comps, false, false)
	if err != nil {
		return 0, err
	}
	defer closeFD(fd)
	return h.dirSize(ctx, fd, comps)
}

func (h *handler) dirSize(ctx context.Context, fd int, path []string) (int64, error) {
	names, err := dirNames(fd)
	if err != nil {
		return 0, err
	}
	var total int64
	for _, name := range names {
		if err = ctx.Err(); err != nil {
			return 0, err
		}
		if strings.HasPrefix(name, ".") {
			continue
		}
		var stat unix.Stat_t
		if unix.Fstatat(fd, name, &stat, unix.AT_SYMLINK_NOFOLLOW) != nil {
			continue
		}
		switch stat.Mode & unix.S_IFMT {
		case unix.S_IFREG:
			total += stat.Size
		case unix.S_IFDIR:
			child, openErr := h.openChild(fd, path, name, dirFlags)
			if openErr != nil {
				continue
			}
			size, sizeErr := h.dirSize(ctx, child, append(slices.Clone(path), name))
			closeFD(child)
			if sizeErr != nil {
				return 0, sizeErr
			}
			total += size
		}
	}
	return total, nil
}

func (h *handler) writeArchive(ctx context.Context, dst io.Writer, targets [][]string) error {
	rootFD, err := openRoot(h.root)
	if err != nil {
		return err
	}
	defer closeFD(rootFD)
	zipWriter := zip.NewWriter(dst)
	for _, comps := range targets {
		if err = h.archiveTarget(ctx, zipWriter, rootFD, comps); err != nil {
			return err
		}
	}
	if err = zipWriter.Close(); err != nil {
		return fmt.Errorf("close archive: %w", err)
	}
	return nil
}

func (h *handler) archiveTarget(ctx context.Context, zipWriter *zip.Writer, rootFD int, comps []string) error {
	parentFD, name, err := h.locate(rootFD, comps, false)
	if err != nil {
		return err
	}
	defer closeFD(parentFD)
	return h.archiveEntry(ctx, zipWriter, parentFD, parentsOf(comps), name, name)
}

func (h *handler) archiveEntry(ctx context.Context, zipWriter *zip.Writer, dirFD int, parents []string, name, zipName string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	var stat unix.Stat_t
	if err := unix.Fstatat(dirFD, name, &stat, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return fmt.Errorf("stat %q: %w", name, err)
	}
	header := &zip.FileHeader{Name: zipName, Modified: time.Unix(stat.Mtim.Unix())}
	header.SetMode(fileModeFromStat(stat.Mode))
	switch stat.Mode & unix.S_IFMT {
	case unix.S_IFREG:
		return h.archiveFile(zipWriter, dirFD, parents, name, header)
	case unix.S_IFDIR:
		return h.archiveDir(ctx, zipWriter, dirFD, parents, name, header)
	}
	return nil
}

func (h *handler) archiveFile(zipWriter *zip.Writer, dirFD int, parents []string, name string, header *zip.FileHeader) error {
	fd, err := h.openChild(dirFD, parents, name, fileFlags)
	if err != nil {
		return err
	}
	file, err := fileFromFD(fd, name)
	if err != nil {
		return err
	}
	defer func() { _ = file.Close() }()
	header.Method = zip.Deflate
	if slices.Contains(storedExtensions, strings.ToLower(filepath.Ext(name))) {
		header.Method = zip.Store
	}
	entryWriter, err := zipWriter.CreateHeader(header)
	if err != nil {
		return fmt.Errorf("zip %q: %w", name, err)
	}
	if _, err = io.Copy(entryWriter, file); err != nil {
		return fmt.Errorf("zip %q: %w", name, err)
	}
	return nil
}

func (h *handler) archiveDir(ctx context.Context, zipWriter *zip.Writer, dirFD int, parents []string, name string, header *zip.FileHeader) error {
	fd, err := h.openChild(dirFD, parents, name, dirFlags)
	if err != nil {
		return err
	}
	defer closeFD(fd)
	prefix := header.Name + "/"
	header.Name = prefix
	if _, err = zipWriter.CreateHeader(header); err != nil {
		return fmt.Errorf("zip %q: %w", name, err)
	}
	names, err := dirNames(fd)
	if err != nil {
		return err
	}
	here := append(slices.Clone(parents), name)
	for _, child := range names {
		if strings.HasPrefix(child, ".") {
			continue
		}
		err = h.archiveEntry(ctx, zipWriter, fd, here, child, prefix+child)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}
