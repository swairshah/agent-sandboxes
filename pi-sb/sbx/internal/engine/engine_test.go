package engine

import (
	"sort"
	"strings"
	"fmt"
	"io/fs"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
)

// sh mutates the tree from a separate process, as the sandboxed agent would.
// FSEvents ignores the engine's own writes.
func sh(t *testing.T, dir, script string) {
	t.Helper()
	cmd := exec.Command("sh", "-ec", script)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("script failed: %v\n%s\n%s", err, script, out)
	}
}

func snapshot(t *testing.T, dir string) map[string]string {
	t.Helper()
	m := map[string]string{}
	filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || p == dir {
			return nil
		}
		rel, _ := filepath.Rel(dir, p)
		info, _ := d.Info()
		switch {
		case d.Type()&fs.ModeSymlink != 0:
			l, _ := os.Readlink(p)
			m[rel] = "link:" + l
		case d.IsDir():
			m[rel] = "dir"
		default:
			b, _ := os.ReadFile(p)
			m[rel] = fmt.Sprintf("%s|%o", b, info.Mode().Perm())
		}
		return nil
	})
	return m
}

func watchers() []string {
	if runtime.GOOS == "darwin" {
		return []string{"fsevents", "walk"}
	}
	return []string{"walk"}
}

func newEngine(t *testing.T, kind string, opts Options) (*Engine, string, string) {
	t.Helper()
	base := t.TempDir()
	root := filepath.Join(base, "work")
	store := filepath.Join(base, "store")
	os.MkdirAll(root, 0o755)
	opts.Watcher = kind
	e, err := Open(store, []RootSpec{{Path: root}}, opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { e.Close() })
	if err := e.Ready(); err != nil {
		t.Fatal(err)
	}
	return e, root, store
}

func TestRmRfAndRestore(t *testing.T) {
	for _, kind := range watchers() {
		t.Run(kind, func(t *testing.T) {
			e, root, _ := newEngine(t, kind, Options{})
			sh(t, root, "mkdir -p src/a .git; echo 1 > src/a/x; echo 2 > src/y; echo h > .git/HEAD; ln -s src/y link")
			c1, err := e.Checkpoint("setup", "auto", nil, false)
			if err != nil || c1 == nil {
				t.Fatalf("checkpoint: %v %v", c1, err)
			}
			want := snapshot(t, root)
			sh(t, root, "rm -rf src .git link; echo junk > junk")
			if _, err := e.Checkpoint("after rm", "auto", nil, false); err != nil {
				t.Fatal(err)
			}
			if _, err := e.Restore(c1.ID); err != nil {
				t.Fatal(err)
			}
			if got := snapshot(t, root); !reflect.DeepEqual(got, want) {
				t.Fatalf("restore mismatch\n got %v\nwant %v", got, want)
			}
		})
	}
}

// TestRandomHistory runs random file operations, checkpoints after each, and
// checks that restoring any checkpoint reproduces the tree exactly, including
// after deleting checkpoints and after restores.
func TestRandomHistory(t *testing.T) {
	for _, kind := range watchers() {
		t.Run(kind, func(t *testing.T) {
			e, root, _ := newEngine(t, kind, Options{})
			seed := int64(1)
			if s := os.Getenv("SBX_SEED"); s != "" {
				fmt.Sscan(s, &seed)
			}
			rng := rand.New(rand.NewSource(seed))
			states := map[int]map[string]string{}
			states[e.store.Head().ID] = snapshot(t, root)
			names := []string{"a", "b", "c", "d"}
			pick := func() string { return names[rng.Intn(len(names))] }
			for step := 0; step < 120; step++ {
				var script string
				a, b, d := pick(), pick(), pick()
				switch rng.Intn(9) {
				case 0, 1:
					script = fmt.Sprintf("mkdir -p %s; echo %d > %s/%s", a, step, a, b)
				case 2:
					script = fmt.Sprintf("echo %d >> %s", step, a)
				case 3:
					script = fmt.Sprintf("rm -rf %s", a)
				case 4:
					script = fmt.Sprintf("if [ -e %s ] && [ %s != %s ]; then rm -rf %s; mv %s %s; fi", a, a, b, b, a, b)
				case 5:
					script = fmt.Sprintf("mkdir -p %s/%s/%s && echo deep%d > %s/%s/%s/f", a, b, d, step, a, b, d)
				case 6:
					script = fmt.Sprintf("rm -rf l%s; ln -s %s l%s", a, b, a)
				case 7:
					script = fmt.Sprintf("if [ -f %s ]; then chmod 600 %s; fi", a, a)
				case 8:
					script = fmt.Sprintf("echo r%d > q.new && mv q.new %s", step, a)
				}
				// Paths can collide with existing files of another type; ignore
				// those failures, the tree is still valid.
				cmd := exec.Command("sh", "-c", script)
				cmd.Dir = root
				cmd.Run()

				c, err := e.Checkpoint(fmt.Sprintf("step %d", step), "auto", nil, false)
				if err != nil {
					t.Fatal(err)
				}
				if c != nil {
					states[c.ID] = snapshot(t, root)
				}

				if step%15 == 14 {
					// Restore a random earlier checkpoint.
					ids := e.ids()
					target := ids[rng.Intn(len(ids))]
					before := snapshot(t, root)
					rc, err := e.Restore(target)
					if err != nil {
						t.Fatalf("restore %d: %v", target, err)
					}
					if got := snapshot(t, root); !reflect.DeepEqual(got, states[target]) {
						v := e.store.viewAt(e.store.Get(target))
						var why strings.Builder
						for k := range states[target] {
							if _, ok := got[k]; !ok {
								fmt.Fprintf(&why, "missing %s: resolve=%+v\n", k, v.resolve(0, k))
							}
						}
						t.Fatalf("step %d: restore to #%d mismatch\n got %v\nwant %v\n%s%s", step, target, got, states[target], why.String(), e.dump())
					}
					// Restore adds a forced "before restore" checkpoint, then the
					// restore checkpoint itself.
					states[rc.ID] = states[target]
					for _, id := range e.ids() {
						if _, ok := states[id]; !ok && id < rc.ID {
							states[id] = before
						}
					}
					for _, id := range e.ids() {
						if _, ok := states[id]; !ok {
							t.Fatalf("checkpoint #%d appeared without a known state", id)
						}
					}
				}
				if step%20 == 19 {
					// Delete a third of the checkpoints at random.
					var del []int
					for _, id := range e.ids() {
						if rng.Intn(3) == 0 {
							del = append(del, id)
						}
					}
					e.Delete(del)
					for _, id := range del {
						delete(states, id)
					}
				}
			}
			// Finally restore every remaining checkpoint and compare.
			for _, id := range e.ids() {
				if _, err := e.Restore(id); err != nil {
					t.Fatalf("final restore %d: %v", id, err)
				}
				if got := snapshot(t, root); !reflect.DeepEqual(got, states[id]) {
					t.Fatalf("final restore to #%d mismatch\n got %v\nwant %v", id, got, states[id])
				}
			}
		})
	}
}

func (e *Engine) ids() []int {
	var out []int
	for _, c := range e.store.Checkpoints() {
		out = append(out, c.ID)
	}
	return out
}

func TestCrossEpochRestore(t *testing.T) {
	for _, kind := range watchers() {
		t.Run(kind, func(t *testing.T) {
			base := t.TempDir()
			root := filepath.Join(base, "work")
			store := filepath.Join(base, "store")
			os.MkdirAll(root, 0o755)
			e, err := Open(store, []RootSpec{{Path: root}}, Options{Watcher: kind})
			if err != nil {
				t.Fatal(err)
			}
			e.Ready()
			sh(t, root, "mkdir d; echo one > d/f; echo top > t")
			c, _ := e.Checkpoint("first session", "auto", nil, false)
			want := snapshot(t, root)
			e.Close()

			sh(t, root, "rm -rf d; echo changed > t; echo new > n")
			e2, err := Open(store, []RootSpec{{Path: root}}, Options{Watcher: kind})
			if err != nil {
				t.Fatal(err)
			}
			defer e2.Close()
			e2.Ready()
			if e2.Epoch() == c.Epoch {
				t.Fatal("expected a new epoch")
			}
			if _, err := e2.Restore(c.ID); err != nil {
				t.Fatal(err)
			}
			if got := snapshot(t, root); !reflect.DeepEqual(got, want) {
				t.Fatalf("cross-epoch restore mismatch\n got %v\nwant %v", got, want)
			}
		})
	}
}

func TestRetentionKeepsRestorable(t *testing.T) {
	e, root, _ := newEngine(t, watchers()[0], Options{KeepLast: 5})
	states := map[int]map[string]string{}
	for i := 0; i < 20; i++ {
		sh(t, root, fmt.Sprintf("echo %d > f%d; rm -f f%d", i, i%4, (i+2)%4))
		c, _ := e.Checkpoint("s", "auto", nil, false)
		if c != nil {
			states[c.ID] = snapshot(t, root)
		}
	}
	if n := len(e.store.Checkpoints()); n > 5 {
		t.Fatalf("kept %d checkpoints, want <= 5", n)
	}
	for _, id := range e.ids() {
		if _, ok := states[id]; !ok {
			continue
		}
		if e.store.Get(id) == nil {
			continue // pruned by retention after an earlier restore
		}
		before := snapshot(t, root)
		rc, err := e.Restore(id)
		if err != nil {
			t.Fatalf("restore #%d: %v", id, err)
		}
		for _, nid := range e.ids() {
			if _, ok := states[nid]; !ok {
				states[nid] = before
			}
		}
		states[rc.ID] = states[id]
		if got := snapshot(t, root); !reflect.DeepEqual(got, states[id]) {
			t.Fatalf("restore #%d mismatch\n got %v\nwant %v", id, got, states[id])
		}
	}
}

func (e *Engine) dump() string {
	var b strings.Builder
	for _, c := range e.store.Checkpoints() {
		fmt.Fprintf(&b, "#%d e%d %s:", c.ID, c.Epoch, c.Label)
		for _, m := range c.Delta {
			keys := make([]string, 0, len(m))
			for k := range m {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				fmt.Fprintf(&b, " %s=%s", k, m[k].T)
			}
		}
		b.WriteString("\n")
	}
	return b.String()
}

func TestEmptySessionsArePruned(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "work")
	store := filepath.Join(base, "store")
	os.MkdirAll(root, 0o755)
	open := func() *Engine {
		e, err := Open(store, []RootSpec{{Path: root}}, Options{Watcher: "walk"})
		if err != nil {
			t.Fatal(err)
		}
		e.Ready()
		return e
	}
	e := open()
	sh(t, root, "echo 1 > f")
	e.Checkpoint("change", "auto", nil, false)
	e.Close()
	for i := 0; i < 3; i++ {
		open().Close()
	}
	e = open()
	defer e.Close()
	epochs := map[int]bool{}
	for _, c := range e.store.Checkpoints() {
		epochs[c.Epoch] = true
	}
	// The session with a change and the live one survive; empty ones go.
	if len(epochs) != 2 {
		t.Fatalf("want 2 epochs, got %v (%s)", epochs, e.dump())
	}
}
