package engine

import "github.com/swairshah/pi-sb/sbx/internal/watch"

// Linux has no FSEvents; fall back to walking.
func newFSEvents(roots []watch.Root, _ string) (watch.Watcher, error) {
	return watch.NewWalkWatcher(roots)
}
