package engine

import "github.com/swairshah/pi-sb/sbx/internal/watch"

func newFSEvents(roots []watch.Root, cookieDir string) (watch.Watcher, error) {
	return watch.NewFSEventsWatcher(roots, cookieDir)
}
