package engine

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/swairshah/pi-sb/sbx/internal/clone"
	"github.com/swairshah/pi-sb/sbx/internal/watch"
)

// Options configures an Engine.
type Options struct {
	// Watcher picks how changes are found: "fsevents" (macOS) or "walk".
	Watcher string
	// KeepLast is the number of checkpoints to keep (0 = unlimited). Older
	// ones are merged forward, so later checkpoints stay restorable.
	KeepLast int
	// KeepDays drops whole epochs older than this many days (0 = forever).
	KeepDays int
	Log      func(format string, args ...any)
}

// Engine records checkpoints for a live box: it watches the roots, captures
// changes into the store and restores them.
type Engine struct {
	mu      sync.Mutex
	store   *Store
	roots   []watch.Root
	watcher watch.Watcher
	opts    Options
	epoch   int
	pending watch.Changes // changes owed to the next checkpoint
	// restoring holds off retention so the restore target is not merged away
	// mid-restore.
	restoring bool

	ready    chan struct{}
	readyErr error
}

// Open starts a new epoch for the box stored at dir. The base clone runs in
// the background; Checkpoint and Restore wait for it.
func Open(dir string, roots []RootSpec, opts Options) (*Engine, error) {
	if opts.Log == nil {
		opts.Log = func(string, ...any) {}
	}
	s, err := OpenStore(dir, roots)
	if err != nil {
		return nil, err
	}
	e := &Engine{store: s, opts: opts, pending: watch.Changes{}, ready: make(chan struct{})}
	for _, r := range roots {
		p, err := watch.Canonical(r.Path)
		if err != nil {
			return nil, err
		}
		e.roots = append(e.roots, watch.Root{Path: p, Excludes: r.Excludes})
	}
	// Start watching before cloning the base, so nothing slips between them.
	switch opts.Watcher {
	case "fsevents":
		e.watcher, err = newFSEvents(e.roots, filepath.Join(dir, "cookies"))
	default:
		e.watcher, err = watch.NewWalkWatcher(e.roots)
	}
	if err != nil {
		return nil, err
	}
	e.epoch = s.nextEpoch()
	go func() {
		e.readyErr = e.startEpoch("session start", "base")
		e.mu.Lock()
		e.dropEmptyEpochs()
		e.applyRetention()
		e.store.gc(e.epoch)
		e.mu.Unlock()
		close(e.ready)
		s.EmptyTrash()
	}()
	return e, nil
}

func (e *Engine) Store() *Store { return e.store }

func (e *Engine) Epoch() int { return e.epoch }

// Ready blocks until the base clone has finished.
func (e *Engine) Ready() error {
	<-e.ready
	return e.readyErr
}

func (e *Engine) startEpoch(label, kind string) error {
	t := time.Now()
	for i, r := range e.roots {
		dst := e.store.abs(e.store.basePath(e.epoch, i))
		if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
			return err
		}
		if err := clone.Tree(r.Path, dst); err != nil {
			return fmt.Errorf("base clone of %s: %w", r.Path, err)
		}
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	c := &Checkpoint{ID: e.store.nextID(), Epoch: e.epoch, Time: time.Now(), Label: label, Kind: kind,
		Stats: Stats{Millis: ms(t)}}
	return e.store.add(c)
}

// Checkpoint captures everything that changed since the previous checkpoint.
// It returns nil when nothing changed, unless force is set.
func (e *Engine) Checkpoint(label, kind string, meta map[string]string, force bool) (*Checkpoint, error) {
	if err := e.Ready(); err != nil {
		return nil, err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.checkpointLocked(label, kind, meta, force)
}

func (e *Engine) checkpointLocked(label, kind string, meta map[string]string, force bool) (*Checkpoint, error) {
	t := time.Now()
	changes, err := e.watcher.Sync()
	if err != nil {
		return nil, err
	}
	for r, m := range e.pending {
		for rel, h := range m {
			changes.Add(r, rel, h)
		}
	}
	e.pending = watch.Changes{}
	head := e.store.Head()
	c := &Checkpoint{ID: e.store.nextID(), Epoch: e.epoch, Time: time.Now(), Label: label, Kind: kind, Meta: meta}
	if changes.Len() > 0 {
		hv := e.store.viewAt(head)
		n := 0
		for r, m := range changes {
			rels := make([]string, 0, len(m))
			for rel := range m {
				rels = append(rels, rel)
			}
			sort.Strings(rels) // parents sort before children
			var trees []string
		next:
			for _, rel := range rels {
				for _, t := range trees {
					if isUnder(rel, t) {
						continue next
					}
				}
				captured, tree, bytes, err := e.capture(c, hv, r, rel, m[rel], &n)
				if err != nil {
					e.opts.Log("capture %s: %v", rel, err)
					continue
				}
				if tree {
					trees = append(trees, rel)
				}
				if captured {
					c.Stats.Paths++
					c.Stats.Bytes += bytes
				}
			}
		}
	}
	if c.size() == 0 && !force {
		return nil, nil
	}
	c.Stats.Millis = ms(t)
	if err := e.store.add(c); err != nil {
		return nil, err
	}
	if !e.restoring {
		e.applyRetention()
	}
	return c, nil
}

// capture records the current state of root/rel into c.
func (e *Engine) capture(c *Checkpoint, hv *view, r int, rel string, h watch.Hint, n *int) (captured, tree bool, bytes int64, err error) {
	abs := filepath.Join(e.roots[r].Path, filepath.FromSlash(rel))
	info, err := os.Lstat(abs)
	prev := hv.resolve(r, rel)
	if errors.Is(err, fs.ErrNotExist) {
		if prev.kind == TAbsent {
			return false, false, 0, nil // created and deleted between checkpoints
		}
		c.setEntry(r, rel, Entry{T: TAbsent})
		return true, false, 0, nil
	}
	if err != nil {
		return false, false, 0, err
	}
	newObj := func() string {
		*n++
		return filepath.ToSlash(filepath.Join(objDir(c.Epoch, c.ID), strconv.Itoa(*n)))
	}
	switch {
	case info.Mode()&fs.ModeSymlink != 0:
		l, err := os.Readlink(abs)
		if err != nil {
			return false, false, 0, err
		}
		if prev.kind == TLink && prev.link == l {
			return false, false, 0, nil
		}
		c.setEntry(r, rel, Entry{T: TLink, L: l})
		return true, false, 0, nil
	case info.Mode().IsRegular():
		o := newObj()
		if err := os.MkdirAll(filepath.Dir(e.store.abs(o)), 0o700); err != nil {
			return false, false, 0, err
		}
		if err := clone.Tree(abs, e.store.abs(o)); err != nil {
			return false, false, 0, err
		}
		c.setEntry(r, rel, Entry{T: TFile, O: o})
		return true, false, info.Size(), nil
	case info.IsDir():
		// A directory that existed before reports its children individually.
		if h&watch.HintTree == 0 && prev.kind == TTree {
			return false, false, 0, nil
		}
		o := newObj()
		if err := os.MkdirAll(filepath.Dir(e.store.abs(o)), 0o700); err != nil {
			return false, false, 0, err
		}
		if err := clone.Tree(abs, e.store.abs(o)); err != nil {
			return false, false, 0, err
		}
		c.setEntry(r, rel, Entry{T: TTree, O: o})
		return true, true, 0, nil
	}
	return false, false, 0, nil // sockets, fifos
}

// Changed lists the paths a restore to id would touch, as absolute paths.
func (e *Engine) Changed(id int) ([]string, error) {
	if err := e.Ready(); err != nil {
		return nil, err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	t := e.store.Get(id)
	if t == nil {
		return nil, fmt.Errorf("no checkpoint #%d", id)
	}
	changes, err := e.watcher.Sync()
	if err != nil {
		return nil, err
	}
	for r, m := range changes {
		for rel, h := range m {
			e.pending.Add(r, rel, h)
		}
	}
	if t.Epoch != e.epoch {
		return nil, nil // whole-tree restore
	}
	set := e.changedSince(t)
	for r, m := range e.pending {
		for rel := range m {
			set.Add(r, rel, watch.HintPath)
		}
	}
	var out []string
	for r, m := range set {
		for rel := range m {
			out = append(out, filepath.Join(e.roots[r].Path, filepath.FromSlash(rel)))
		}
	}
	sort.Strings(out)
	return out, nil
}

func (e *Engine) changedSince(t *Checkpoint) watch.Changes {
	set := watch.Changes{}
	for _, c := range e.store.ckpts {
		if c.Epoch == t.Epoch && c.ID > t.ID {
			for rk, m := range c.Delta {
				r, _ := strconv.Atoi(rk)
				for rel := range m {
					set.Add(r, rel, watch.HintPath)
				}
			}
		}
	}
	return set
}

// Restore makes the roots match checkpoint id. It first checkpoints the
// current state, so a restore can itself be undone.
func (e *Engine) Restore(id int) (*Checkpoint, error) {
	if err := e.Ready(); err != nil {
		return nil, err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	t := e.store.Get(id)
	if t == nil {
		return nil, fmt.Errorf("no checkpoint #%d", id)
	}
	e.restoring = true
	defer func() {
		e.restoring = false
		e.applyRetention()
	}()
	// Forced, so there is always an undo target even when nothing changed.
	if _, err := e.checkpointLocked(fmt.Sprintf("before restore to #%d", id), "auto", nil, true); err != nil {
		return nil, err
	}
	start := time.Now()
	v := e.store.viewAt(t)
	if t.Epoch != e.epoch {
		return e.restoreOtherEpoch(v, t, start)
	}
	c := &Checkpoint{ID: e.store.nextID(), Epoch: e.epoch, Time: time.Now(), Kind: "restore",
		Label: fmt.Sprintf("restored #%d", id), Meta: map[string]string{"restored": strconv.Itoa(id)}}
	var errs []error
	for r, m := range e.changedSince(t) {
		rels := make([]string, 0, len(m))
		for rel := range m {
			rels = append(rels, rel)
		}
		sort.Strings(rels)
		var done []string
	next:
		for _, rel := range rels {
			for _, d := range done {
				if rel == d || isUnder(rel, d) {
					continue next
				}
			}
			out := map[string]Entry{}
			if err := v.materialize(e.roots[r].Path, r, rel, out); err != nil {
				errs = append(errs, err)
			}
			for k, en := range out {
				c.setEntry(r, k, en)
			}
			done = append(done, rel)
		}
	}
	// Our own writes are marked by FSEvents and skipped; the walk watcher needs
	// a sync to forget them.
	if _, ok := e.watcher.(*watch.WalkWatcher); ok {
		e.watcher.Sync()
	}
	c.Stats.Paths = c.size()
	c.Stats.Millis = ms(start)
	if err := e.store.add(c); err != nil {
		return nil, err
	}
	return c, errors.Join(errs...)
}

// restoreOtherEpoch rebuilds every root from an older session's checkpoint,
// then starts a fresh epoch from the result.
func (e *Engine) restoreOtherEpoch(v *view, t *Checkpoint, start time.Time) (*Checkpoint, error) {
	var errs []error
	for r, root := range e.roots {
		if r >= len(e.store.Info.Roots) {
			break
		}
		if err := v.materialize(root.Path, r, "", map[string]Entry{}); err != nil {
			errs = append(errs, err)
		}
	}
	e.watcher.Sync()
	e.epoch = e.store.nextEpoch()
	e.mu.Unlock()
	err := e.startEpoch(fmt.Sprintf("restored #%d (from an earlier session)", t.ID), "restore")
	e.mu.Lock()
	if err != nil {
		errs = append(errs, err)
	}
	return e.store.Head(), errors.Join(errs...)
}

// Delete removes checkpoints. A deleted checkpoint's changes merge into the
// next one in its epoch, so every remaining checkpoint restores exactly as
// before.
func (e *Engine) Delete(ids []int) (int, error) {
	if err := e.Ready(); err != nil {
		return 0, err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	n := e.store.deleteCheckpoints(ids, e.epoch, e.pending)
	e.store.gc(e.epoch)
	go e.store.EmptyTrash()
	return n, nil
}

func (s *Store) deleteCheckpoints(ids []int, liveEpoch int, pending watch.Changes) int {
	sort.Ints(ids)
	n := 0
	for _, id := range ids {
		c := s.Get(id)
		if c == nil {
			continue
		}
		var succ *Checkpoint
		for _, o := range s.ckpts {
			if o.Epoch == c.Epoch && o.ID > c.ID {
				succ = o
				break
			}
		}
		switch {
		case succ != nil:
			// Check shadowing against succ's own entries only: entries merged in
			// from c are older than succ and must not hide each other.
			orig := &Checkpoint{Delta: map[string]map[string]Entry{}}
			for rk, m := range succ.Delta {
				orig.Delta[rk] = m
			}
			merged := map[string]map[string]Entry{}
			for rk, m := range c.Delta {
				r, _ := strconv.Atoi(rk)
				for rel, en := range m {
					if !shadowed(orig, r, rel) {
						if merged[rk] == nil {
							merged[rk] = map[string]Entry{}
						}
						merged[rk][rel] = en
					}
				}
			}
			for rk, m := range merged {
				r, _ := strconv.Atoi(rk)
				for rel, en := range m {
					succ.setEntry(r, rel, en)
				}
			}
			succ.Stats.Paths = succ.size()
			if err := s.save(succ); err != nil {
				continue
			}
		case c.Epoch == liveEpoch && pending != nil:
			// The live head: whatever it captured must be captured again by
			// the next checkpoint.
			for rk, m := range c.Delta {
				r, _ := strconv.Atoi(rk)
				for rel, en := range m {
					h := watch.HintPath
					if en.T == TTree {
						h |= watch.HintTree
					}
					pending.Add(r, rel, h)
				}
			}
		}
		os.Remove(filepath.Join(s.Dir, "ckpt", strconv.Itoa(id)+".json"))
		for i, o := range s.ckpts {
			if o == c {
				s.ckpts = append(s.ckpts[:i], s.ckpts[i+1:]...)
				break
			}
		}
		n++
	}
	return n
}

func shadowed(c *Checkpoint, root int, rel string) bool {
	m := c.entries(root)
	if _, ok := m[rel]; ok {
		return true
	}
	for _, a := range parentsOf(rel) {
		if _, ok := m[a]; ok {
			return true
		}
	}
	return false
}

// gc trashes objects no checkpoint references and epochs with no checkpoints
// (other than the live one).
func (s *Store) gc(liveEpoch int) {
	live := map[string]bool{}
	epochs := map[int]bool{liveEpoch: true}
	for _, c := range s.ckpts {
		epochs[c.Epoch] = true
		for _, m := range c.Delta {
			for _, en := range m {
				if en.O != "" {
					live[objectOf(en.O)] = true
				}
			}
		}
	}
	ents, _ := os.ReadDir(filepath.Join(s.Dir, "epochs"))
	for _, ep := range ents {
		n, err := strconv.Atoi(ep.Name())
		if err != nil {
			continue
		}
		if !epochs[n] {
			s.trash(filepath.Join("epochs", ep.Name()))
			continue
		}
		objs, _ := os.ReadDir(filepath.Join(s.Dir, "epochs", ep.Name(), "obj"))
		for _, o := range objs {
			rel := filepath.ToSlash(filepath.Join("epochs", ep.Name(), "obj", o.Name()))
			if !live[rel] {
				s.trash(rel)
			}
		}
	}
}

// objectOf maps a content path to the object directory that owns it:
// epochs/<e>/obj/<id>/... -> epochs/<e>/obj/<id>.
func objectOf(p string) string {
	parts := strings.SplitN(p, "/", 5)
	if len(parts) >= 4 && parts[2] == "obj" {
		return path.Join(parts[:4]...)
	}
	return p
}

// dropEmptyEpochs deletes earlier sessions in which nothing changed. Their
// base is a full clone (about 400 bytes of metadata per file), and the new
// session's base already covers that state.
func (e *Engine) dropEmptyEpochs() {
	changed := map[int]bool{}
	for _, c := range e.store.ckpts {
		if c.Kind != "base" || c.size() > 0 {
			changed[c.Epoch] = true
		}
	}
	var drop []int
	for _, c := range e.store.ckpts {
		if c.Epoch != e.epoch && !changed[c.Epoch] {
			drop = append(drop, c.ID)
		}
	}
	if len(drop) > 0 {
		e.store.deleteCheckpoints(drop, e.epoch, e.pending)
	}
}

func (e *Engine) applyRetention() {
	if e.opts.KeepDays > 0 {
		cutoff := time.Now().AddDate(0, 0, -e.opts.KeepDays)
		var old []int
		for _, c := range e.store.ckpts {
			if c.Epoch != e.epoch && c.Time.Before(cutoff) {
				old = append(old, c.ID)
			}
		}
		if len(old) > 0 {
			e.store.deleteCheckpoints(old, e.epoch, e.pending)
		}
	}
	if e.opts.KeepLast > 0 && len(e.store.ckpts) > e.opts.KeepLast {
		var drop []int
		for _, c := range e.store.ckpts[:len(e.store.ckpts)-e.opts.KeepLast] {
			drop = append(drop, c.ID)
		}
		e.store.deleteCheckpoints(drop, e.epoch, e.pending)
		e.store.gc(e.epoch)
		go e.store.EmptyTrash()
	}
}

func (e *Engine) Close() error {
	if e.watcher != nil {
		return e.watcher.Close()
	}
	return nil
}

func ms(t time.Time) float64 { return float64(time.Since(t).Microseconds()) / 1000 }
