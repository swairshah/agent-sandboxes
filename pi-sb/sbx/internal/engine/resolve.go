package engine

import (
	"errors"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/swairshah/pi-sb/sbx/internal/clone"
)

// source is where the content of a path at some checkpoint lives.
type source struct {
	kind   string // TFile, TLink, TTree (any directory), TAbsent
	path   string // store-relative content path for files and directories
	link   string
	origin int // ID of the checkpoint the content came from; 0 for the base
}

// view is the state of one epoch as of one checkpoint.
type view struct {
	s     *Store
	epoch int
	cks   []*Checkpoint // oldest first, all <= the target
}

func (s *Store) viewAt(c *Checkpoint) *view {
	return &view{s: s, epoch: c.Epoch, cks: s.epochCheckpoints(c.Epoch, c.ID)}
}

// resolve finds the state of root/rel. Newer checkpoints win; within one
// checkpoint the deepest matching entry wins.
func (v *view) resolve(root int, rel string) source {
	for i := len(v.cks) - 1; i >= 0; i-- {
		m := v.cks[i].entries(root)
		if len(m) == 0 {
			continue
		}
		if e, ok := m[rel]; ok {
			return v.fromEntry(e, "", v.cks[i].ID)
		}
		for _, a := range parentsOf(rel) {
			if e, ok := m[a]; ok {
				if e.T != TTree {
					return source{kind: TAbsent}
				}
				return v.fromEntry(e, suffix(rel, a), v.cks[i].ID)
			}
		}
	}
	return v.stat(path.Join(filepath.ToSlash(v.s.basePath(v.epoch, root)), rel), 0)
}

func (v *view) fromEntry(e Entry, sub string, origin int) source {
	switch e.T {
	case TAbsent:
		return source{kind: TAbsent}
	case TLink:
		if sub != "" {
			return source{kind: TAbsent}
		}
		return source{kind: TLink, link: e.L, origin: origin}
	case TFile:
		if sub != "" {
			return source{kind: TAbsent}
		}
		return source{kind: TFile, path: e.O, origin: origin}
	default:
		return v.stat(path.Join(e.O, sub), origin)
	}
}

// stat classifies a content path inside the store.
func (v *view) stat(rel string, origin int) source {
	p := v.s.abs(rel)
	info, err := os.Lstat(p)
	if err != nil {
		return source{kind: TAbsent}
	}
	switch {
	case info.Mode()&fs.ModeSymlink != 0:
		l, _ := os.Readlink(p)
		return source{kind: TLink, link: l, origin: origin}
	case info.IsDir():
		return source{kind: TTree, path: rel, origin: origin}
	case info.Mode().IsRegular():
		return source{kind: TFile, path: rel, origin: origin}
	}
	return source{kind: TAbsent}
}

// overrides lists entries strictly under rel in checkpoints newer than origin.
func (v *view) overrides(root int, rel string, origin int) []string {
	var out []string
	for _, c := range v.cks {
		// Entries in the origin checkpoint itself are deeper than the one that
		// matched, so they override it too.
		if c.ID < origin {
			continue
		}
		for k := range c.entries(root) {
			if isUnder(k, rel) {
				out = append(out, k)
			}
		}
	}
	return out
}

func (src source) entry() Entry {
	switch src.kind {
	case TFile:
		return Entry{T: TFile, O: src.path}
	case TLink:
		return Entry{T: TLink, L: src.link}
	case TTree:
		return Entry{T: TTree, O: src.path}
	}
	return Entry{T: TAbsent}
}

// materialize makes rootDir/rel match the view, touching nothing outside it.
// It returns the entries that describe what it wrote.
func (v *view) materialize(rootDir string, root int, rel string, out map[string]Entry) error {
	src := v.resolve(root, rel)
	dst := filepath.Join(rootDir, filepath.FromSlash(rel))
	if rel != "" {
		if err := removeAll(dst); err != nil {
			return err
		}
	}
	switch src.kind {
	case TAbsent:
		out[rel] = src.entry()
		return nil
	case TLink:
		out[rel] = src.entry()
		os.MkdirAll(filepath.Dir(dst), 0o755)
		return os.Symlink(src.link, dst)
	case TFile:
		out[rel] = src.entry()
		os.MkdirAll(filepath.Dir(dst), 0o755)
		return clone.Tree(v.s.abs(src.path), dst)
	}
	// A directory. Clone it whole unless newer checkpoints changed paths below
	// it, in which case rebuild it child by child.
	over := v.overrides(root, rel, src.origin)
	if rel != "" && len(over) == 0 {
		out[rel] = src.entry()
		os.MkdirAll(filepath.Dir(dst), 0o755)
		return clone.Tree(v.s.abs(src.path), dst)
	}
	if rel != "" {
		out[rel] = src.entry()
		info, err := os.Stat(v.s.abs(src.path))
		if err != nil {
			return err
		}
		if err := os.MkdirAll(dst, info.Mode().Perm()|0o700); err != nil {
			return err
		}
	}
	names := map[string]bool{}
	if ents, err := os.ReadDir(v.s.abs(src.path)); err == nil {
		for _, e := range ents {
			names[e.Name()] = true
		}
	}
	for _, k := range over {
		names[strings.SplitN(suffix(k, rel), "/", 2)[0]] = true
	}
	if rel == "" {
		// The root is never replaced, so children that should not exist must
		// be removed explicitly.
		if ents, err := os.ReadDir(dst); err == nil {
			for _, e := range ents {
				names[e.Name()] = true
			}
		}
	}
	keys := make([]string, 0, len(names))
	for n := range names {
		keys = append(keys, n)
	}
	sort.Strings(keys)
	var errs []error
	for _, n := range keys {
		if err := v.materialize(rootDir, root, path.Join(rel, n), out); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func suffix(rel, dir string) string {
	if dir == "" {
		return rel
	}
	return rel[len(dir)+1:]
}

// removeAll deletes p even if the agent made it or its parent read-only.
func removeAll(p string) error {
	if _, err := os.Lstat(p); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err := os.RemoveAll(p); err == nil {
		return nil
	}
	if info, err := os.Stat(filepath.Dir(p)); err == nil {
		os.Chmod(filepath.Dir(p), info.Mode().Perm()|0o700)
	}
	makeWritable(p)
	return os.RemoveAll(p)
}

func objDir(epoch, id int) string {
	return filepath.Join("epochs", strconv.Itoa(epoch), "obj", strconv.Itoa(id))
}
