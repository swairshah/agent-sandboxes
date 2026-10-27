// Package watch reports which paths under a set of roots changed between two
// calls to Sync. The engine turns those paths into checkpoint deltas, so a
// checkpoint costs O(changes) instead of O(files).
package watch

import (
	"path/filepath"
	"strings"
)

// Hint says how the engine should capture a changed path.
type Hint uint8

const (
	// HintPath means "look at this path and capture whatever is there now".
	HintPath Hint = 1 << iota
	// HintTree means the path may be a directory whose children were not
	// reported individually (renamed in, or events were dropped), so the whole
	// subtree must be captured.
	HintTree
)

// Changes maps root index -> relative path -> hint. The root itself is "".
type Changes map[int]map[string]Hint

func (c Changes) Add(root int, rel string, h Hint) {
	m := c[root]
	if m == nil {
		m = map[string]Hint{}
		c[root] = m
	}
	m[rel] |= h
}

func (c Changes) Len() int {
	n := 0
	for _, m := range c {
		n += len(m)
	}
	return n
}

// Watcher tracks changes under roots.
type Watcher interface {
	// Sync returns everything that changed since the previous Sync. Every
	// change that completed before Sync was called is included.
	Sync() (Changes, error)
	Close() error
}

// Root is a directory to watch, with paths (relative, slash separated) whose
// subtrees are ignored.
type Root struct {
	Path     string
	Excludes []string
}

func (r Root) excluded(rel string) bool {
	for _, ex := range r.Excludes {
		if rel == ex || strings.HasPrefix(rel, ex+"/") {
			return true
		}
	}
	return false
}

// relTo returns the path of abs relative to root, or ok=false if abs is not
// inside root.
func relTo(root, abs string) (string, bool) {
	if abs == root {
		return "", true
	}
	if strings.HasPrefix(abs, root+"/") {
		return filepath.ToSlash(abs[len(root)+1:]), true
	}
	return "", false
}
