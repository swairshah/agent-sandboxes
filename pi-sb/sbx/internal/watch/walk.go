package watch

import (
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
)

// sig identifies the state of one directory entry. ctime cannot be set from
// user space, so a file rewritten with its old mtime still shows up.
type sig struct {
	ino   uint64
	size  int64
	mtime int64
	ctime int64
	mode  fs.FileMode
}

func sigOf(info fs.FileInfo) sig {
	s := sig{size: info.Size(), mtime: info.ModTime().UnixNano(), mode: info.Mode()}
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		s.ino = uint64(st.Ino)
		s.ctime = ctimeNanos(st)
	}
	return s
}

// WalkWatcher finds changes by walking every root and comparing entries with
// the previous walk. It works everywhere but costs O(files) per Sync.
type WalkWatcher struct {
	roots []Root
	sigs  []map[string]sig
}

func NewWalkWatcher(roots []Root) (*WalkWatcher, error) {
	w := &WalkWatcher{roots: roots, sigs: make([]map[string]sig, len(roots))}
	for i := range roots {
		m, err := w.scan(i)
		if err != nil {
			return nil, err
		}
		w.sigs[i] = m
	}
	return w, nil
}

func (w *WalkWatcher) scan(i int) (map[string]sig, error) {
	root := w.roots[i]
	m := map[string]sig{}
	err := filepath.WalkDir(root.Path, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if os.IsNotExist(err) || os.IsPermission(err) {
				return nil
			}
			return err
		}
		rel, _ := relTo(root.Path, p)
		if rel != "" && root.excluded(rel) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		m[rel] = sigOf(info)
		return nil
	})
	return m, err
}

func (w *WalkWatcher) Sync() (Changes, error) {
	out := Changes{}
	for i := range w.roots {
		cur, err := w.scan(i)
		if err != nil {
			return nil, err
		}
		prev := w.sigs[i]
		for rel, s := range cur {
			old, ok := prev[rel]
			switch {
			case !ok && s.mode.IsDir():
				out.Add(i, rel, HintTree)
			case !ok:
				out.Add(i, rel, HintPath)
			case s.mode.IsDir():
				if !old.mode.IsDir() {
					out.Add(i, rel, HintTree)
				}
			case s != old:
				out.Add(i, rel, HintPath)
			}
		}
		for rel := range prev {
			if _, ok := cur[rel]; !ok {
				out.Add(i, rel, HintPath)
			}
		}
		w.sigs[i] = cur
	}
	return out, nil
}

func (w *WalkWatcher) Close() error { return nil }
