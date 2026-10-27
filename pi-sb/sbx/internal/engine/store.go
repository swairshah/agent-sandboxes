// Package engine stores sandbox checkpoints as copy-on-write deltas.
//
// Each epoch starts with a base: a clone of every root (one clonefile(2) call
// per root on APFS). Each checkpoint stores only the paths that changed since
// the previous checkpoint, as clones of their current content. The state at
// checkpoint k is the newest entry for a path among checkpoints <= k, falling
// back to the base. Restoring touches only paths changed after k.
//
// Layout of a box store:
//
//	box.json              roots and settings
//	epochs/<e>/base/<r>   clone of root r when epoch e started
//	epochs/<e>/obj/<id>   cloned files and trees referenced by checkpoints
//	ckpt/<id>.json        one checkpoint
//	trash/                directories waiting for background deletion
//	cookies/              FSEvents sync cookies
package engine

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Entry types.
const (
	TFile    = "f" // regular file, O is its clone
	TLink    = "l" // symlink, L is the target
	TTree    = "T" // directory, O is a clone of the whole subtree
	TAbsent  = "x" // path does not exist
	TBaseRef = "b" // used only during resolution: content lives in the base
)

// Entry is the recorded state of one path in a checkpoint.
type Entry struct {
	T string `json:"t"`
	// O is the store-relative path of the content (for f and T). It can point
	// inside another checkpoint's tree or into the base after a restore.
	O string `json:"o,omitempty"`
	L string `json:"l,omitempty"`
}

// Checkpoint is one point in the sandbox timeline.
type Checkpoint struct {
	ID    int                         `json:"id"`
	Epoch int                         `json:"epoch"`
	Time  time.Time                   `json:"time"`
	Label string                      `json:"label"`
	Kind  string                      `json:"kind"` // base, auto, manual, restore
	Meta  map[string]string           `json:"meta,omitempty"`
	Delta map[string]map[string]Entry `json:"delta"` // root index -> rel path -> entry
	Stats Stats                       `json:"stats"`
}

type Stats struct {
	Paths  int     `json:"paths"`
	Bytes  int64   `json:"bytes"`
	Millis float64 `json:"ms"`
}

func (c *Checkpoint) entries(root int) map[string]Entry {
	return c.Delta[strconv.Itoa(root)]
}

func (c *Checkpoint) setEntry(root int, rel string, e Entry) {
	k := strconv.Itoa(root)
	if c.Delta == nil {
		c.Delta = map[string]map[string]Entry{}
	}
	m := c.Delta[k]
	if m == nil {
		m = map[string]Entry{}
		c.Delta[k] = m
	}
	m[rel] = e
}

func (c *Checkpoint) size() int {
	n := 0
	for _, m := range c.Delta {
		n += len(m)
	}
	return n
}

// RootSpec describes one checkpointed directory.
type RootSpec struct {
	Path     string   `json:"path"`
	Excludes []string `json:"excludes,omitempty"`
}

// BoxInfo is box.json.
type BoxInfo struct {
	Roots   []RootSpec `json:"roots"`
	Created time.Time  `json:"created"`
}

// Store is the on-disk checkpoint store for one box.
type Store struct {
	Dir   string
	Info  BoxInfo
	ckpts []*Checkpoint // sorted by ID
}

func OpenStore(dir string, roots []RootSpec) (*Store, error) {
	for _, d := range []string{"epochs", "ckpt", "trash", "cookies"} {
		if err := os.MkdirAll(filepath.Join(dir, d), 0o700); err != nil {
			return nil, err
		}
	}
	s := &Store{Dir: dir}
	b, err := os.ReadFile(filepath.Join(dir, "box.json"))
	switch {
	case err == nil:
		if err := json.Unmarshal(b, &s.Info); err != nil {
			return nil, err
		}
	case errors.Is(err, os.ErrNotExist):
		if roots == nil {
			return nil, fmt.Errorf("no sandbox store at %s", dir)
		}
		s.Info = BoxInfo{Roots: roots, Created: time.Now()}
	default:
		return nil, err
	}
	if roots != nil {
		s.Info.Roots = roots
		if err := writeJSON(filepath.Join(dir, "box.json"), s.Info); err != nil {
			return nil, err
		}
	}
	if err := s.loadCheckpoints(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) loadCheckpoints() error {
	ents, err := os.ReadDir(filepath.Join(s.Dir, "ckpt"))
	if err != nil {
		return err
	}
	s.ckpts = nil
	for _, e := range ents {
		if !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(s.Dir, "ckpt", e.Name()))
		if err != nil {
			return err
		}
		c := &Checkpoint{}
		if err := json.Unmarshal(b, c); err != nil {
			continue // a torn write from a crash; ignore it
		}
		s.ckpts = append(s.ckpts, c)
	}
	sort.Slice(s.ckpts, func(i, j int) bool { return s.ckpts[i].ID < s.ckpts[j].ID })
	return nil
}

func (s *Store) Checkpoints() []*Checkpoint { return s.ckpts }

func (s *Store) Get(id int) *Checkpoint {
	i := sort.Search(len(s.ckpts), func(i int) bool { return s.ckpts[i].ID >= id })
	if i < len(s.ckpts) && s.ckpts[i].ID == id {
		return s.ckpts[i]
	}
	return nil
}

func (s *Store) Head() *Checkpoint {
	if len(s.ckpts) == 0 {
		return nil
	}
	return s.ckpts[len(s.ckpts)-1]
}

func (s *Store) nextID() int {
	if h := s.Head(); h != nil {
		return h.ID + 1
	}
	return 1
}

func (s *Store) nextEpoch() int {
	ents, _ := os.ReadDir(filepath.Join(s.Dir, "epochs"))
	max := 0
	for _, e := range ents {
		if n, err := strconv.Atoi(e.Name()); err == nil && n > max {
			max = n
		}
	}
	return max + 1
}

// epochCheckpoints returns the checkpoints of epoch e with ID <= upto, oldest
// first.
func (s *Store) epochCheckpoints(e, upto int) []*Checkpoint {
	var out []*Checkpoint
	for _, c := range s.ckpts {
		if c.Epoch == e && c.ID <= upto {
			out = append(out, c)
		}
	}
	return out
}

func (s *Store) save(c *Checkpoint) error {
	return writeJSON(filepath.Join(s.Dir, "ckpt", strconv.Itoa(c.ID)+".json"), c)
}

func (s *Store) add(c *Checkpoint) error {
	if err := s.save(c); err != nil {
		return err
	}
	s.ckpts = append(s.ckpts, c)
	return nil
}

func (s *Store) basePath(epoch, root int) string {
	return filepath.Join("epochs", strconv.Itoa(epoch), "base", strconv.Itoa(root))
}

func (s *Store) abs(rel string) string { return filepath.Join(s.Dir, rel) }

// trash moves a store path into trash/ for deletion in the background.
func (s *Store) trash(rel string) {
	src := s.abs(rel)
	dst := filepath.Join(s.Dir, "trash", fmt.Sprintf("%d-%s", time.Now().UnixNano(), strings.ReplaceAll(rel, "/", "_")))
	if err := os.Rename(src, dst); err != nil && !errors.Is(err, os.ErrNotExist) {
		os.RemoveAll(src)
	}
}

// EmptyTrash deletes everything in trash/. Deleting a big tree is O(files), so
// callers run it in the background.
func (s *Store) EmptyTrash() {
	ents, _ := os.ReadDir(filepath.Join(s.Dir, "trash"))
	for _, e := range ents {
		p := filepath.Join(s.Dir, "trash", e.Name())
		makeWritable(p)
		os.RemoveAll(p)
	}
}

// makeWritable fixes directory modes so RemoveAll can descend into trees the
// agent left read-only.
func makeWritable(p string) {
	filepath.Walk(p, func(q string, info os.FileInfo, err error) error {
		if err == nil && info.IsDir() && info.Mode().Perm()&0o700 != 0o700 {
			os.Chmod(q, info.Mode().Perm()|0o700)
		}
		return nil
	})
}

func writeJSON(p string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// parentsOf returns rel's ancestors, nearest first, excluding "" unless rel is
// non-empty (the root is everyone's ancestor).
func parentsOf(rel string) []string {
	var out []string
	for rel != "" {
		rel = path.Dir(rel)
		if rel == "." {
			rel = ""
		}
		out = append(out, rel)
	}
	return out
}

func isUnder(rel, dir string) bool {
	return dir == "" && rel != "" || strings.HasPrefix(rel, dir+"/")
}
