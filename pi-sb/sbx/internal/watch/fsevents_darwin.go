package watch

/*
#cgo LDFLAGS: -framework CoreServices
#include <CoreServices/CoreServices.h>
#include <dispatch/dispatch.h>
#include <stdlib.h>

extern void sbxFSEventsCallback(uintptr_t handle, size_t n, char **paths, FSEventStreamEventFlags *flags, FSEventStreamEventId *ids);

static void sbx_cb(ConstFSEventStreamRef s, void *info, size_t n, void *paths,
                   const FSEventStreamEventFlags flags[], const FSEventStreamEventId ids[]) {
	sbxFSEventsCallback((uintptr_t)info, n, (char **)paths, (FSEventStreamEventFlags *)flags, (FSEventStreamEventId *)ids);
}

static FSEventStreamRef sbx_start(uintptr_t handle, char **paths, int npaths) {
	CFMutableArrayRef arr = CFArrayCreateMutable(NULL, npaths, &kCFTypeArrayCallBacks);
	for (int i = 0; i < npaths; i++) {
		CFStringRef s = CFStringCreateWithCString(NULL, paths[i], kCFStringEncodingUTF8);
		CFArrayAppendValue(arr, s);
		CFRelease(s);
	}
	FSEventStreamContext ctx = {0, (void *)handle, NULL, NULL, NULL};
	FSEventStreamRef stream = FSEventStreamCreate(NULL, sbx_cb, &ctx, arr,
		kFSEventStreamEventIdSinceNow, 0.0,
		kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer |
		kFSEventStreamCreateFlagMarkSelf | kFSEventStreamCreateFlagWatchRoot);
	CFRelease(arr);
	if (stream == NULL) return NULL;
	dispatch_queue_t q = dispatch_queue_create("sbx.fsevents", DISPATCH_QUEUE_SERIAL);
	FSEventStreamSetDispatchQueue(stream, q);
	if (!FSEventStreamStart(stream)) {
		FSEventStreamInvalidate(stream);
		FSEventStreamRelease(stream);
		return NULL;
	}
	return stream;
}

static void sbx_stop(FSEventStreamRef stream) {
	FSEventStreamStop(stream);
	FSEventStreamInvalidate(stream);
	FSEventStreamRelease(stream);
}

static void sbx_flush(FSEventStreamRef stream) { FSEventStreamFlushSync(stream); }
*/
import "C"

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime/cgo"
	"strconv"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

const (
	flagMustScanSubDirs = 0x1
	flagUserDropped     = 0x2
	flagKernelDropped   = 0x4
	flagRootChanged     = 0x20
	flagItemCreated     = 0x100
	flagItemRenamed     = 0x800
	flagItemIsDir       = 0x20000
	flagOwnEvent        = 0x80000
)

// FSEventsWatcher gets change notifications from the kernel, so Sync costs
// O(changes). To be sure every earlier write has been delivered, Sync writes a
// cookie file and waits for its event: FSEvents delivers events for one volume
// in order.
type FSEventsWatcher struct {
	roots     []Root
	cookieDir string
	stream    C.FSEventStreamRef
	handle    cgo.Handle

	mu      sync.Mutex
	pending Changes
	waiters map[string]chan struct{}
	seq     int
}

// NewFSEventsWatcher watches roots. cookieDir must be on the same volume as
// the roots and must not be inside any of them.
func NewFSEventsWatcher(roots []Root, cookieDir string) (*FSEventsWatcher, error) {
	if err := os.MkdirAll(cookieDir, 0o700); err != nil {
		return nil, err
	}
	w := &FSEventsWatcher{pending: Changes{}, waiters: map[string]chan struct{}{}}
	for _, r := range roots {
		p, err := Canonical(r.Path)
		if err != nil {
			return nil, err
		}
		w.roots = append(w.roots, Root{Path: p, Excludes: r.Excludes})
	}
	cd, err := Canonical(cookieDir)
	if err != nil {
		return nil, err
	}
	w.cookieDir = cd

	paths := make([]*C.char, 0, len(w.roots)+1)
	for _, r := range w.roots {
		paths = append(paths, C.CString(r.Path))
	}
	paths = append(paths, C.CString(w.cookieDir))
	defer func() {
		for _, p := range paths {
			C.free(unsafe.Pointer(p))
		}
	}()
	w.handle = cgo.NewHandle(w)
	w.stream = C.sbx_start(C.uintptr_t(w.handle), (**C.char)(unsafe.Pointer(&paths[0])), C.int(len(paths)))
	if w.stream == nil {
		w.handle.Delete()
		return nil, errors.New("FSEventStreamCreate failed")
	}
	// The stream starts asynchronously; a first sync guarantees it is live
	// before the caller relies on it.
	if _, err := w.Sync(); err != nil {
		w.Close()
		return nil, err
	}
	return w, nil
}

//export sbxFSEventsCallback
func sbxFSEventsCallback(handle C.uintptr_t, n C.size_t, paths **C.char, flags *C.FSEventStreamEventFlags, ids *C.FSEventStreamEventId) {
	w := cgo.Handle(handle).Value().(*FSEventsWatcher)
	ps := unsafe.Slice(paths, int(n))
	fs := unsafe.Slice(flags, int(n))
	w.mu.Lock()
	defer w.mu.Unlock()
	var done []chan struct{}
	for i := range ps {
		w.handleEvent(C.GoString(ps[i]), uint32(fs[i]), &done)
	}
	// Signal cookie waiters only after the whole batch is recorded.
	for _, ch := range done {
		close(ch)
	}
}

func (w *FSEventsWatcher) handleEvent(path string, flags uint32, done *[]chan struct{}) {
	if rel, ok := relTo(w.cookieDir, path); ok {
		if ch := w.waiters[rel]; ch != nil {
			delete(w.waiters, rel)
			*done = append(*done, ch)
		}
		return
	}
	// The engine's own restores are not agent changes.
	if flags&flagOwnEvent != 0 {
		return
	}
	dropped := flags&(flagMustScanSubDirs|flagUserDropped|flagKernelDropped|flagRootChanged) != 0
	for i, r := range w.roots {
		rel, ok := relTo(r.Path, path)
		if !ok {
			continue
		}
		if rel != "" && r.excluded(rel) {
			return
		}
		h := HintPath
		if dropped || (flags&flagItemIsDir != 0 && flags&(flagItemCreated|flagItemRenamed) != 0) {
			h |= HintTree
		}
		w.pending.Add(i, rel, h)
		return
	}
}

// Sync waits until every change made before the call has been delivered, then
// returns and clears the pending set.
func (w *FSEventsWatcher) Sync() (Changes, error) {
	w.mu.Lock()
	w.seq++
	name := strconv.Itoa(os.Getpid()) + "-" + strconv.Itoa(w.seq)
	ch := make(chan struct{})
	w.waiters[name] = ch
	w.mu.Unlock()

	cookie := filepath.Join(w.cookieDir, name)
	if err := os.WriteFile(cookie, nil, 0o600); err != nil {
		return nil, err
	}
	defer os.Remove(cookie)
	select {
	case <-ch:
	case <-time.After(2 * time.Second):
		// Should not happen; fall back to an explicit flush.
		C.sbx_flush(w.stream)
		w.mu.Lock()
		delete(w.waiters, name)
		w.mu.Unlock()
	}
	w.mu.Lock()
	out := w.pending
	w.pending = Changes{}
	w.mu.Unlock()
	return out, nil
}

func (w *FSEventsWatcher) Close() error {
	if w.stream != nil {
		C.sbx_stop(w.stream)
		w.stream = nil
		w.handle.Delete()
	}
	return nil
}

// Canonical resolves symlinks and returns the path with the on-disk case,
// which is what FSEvents reports on case-insensitive volumes.
func Canonical(p string) (string, error) {
	p, err := filepath.EvalSymlinks(p)
	if err != nil {
		return "", err
	}
	fd, err := unix.Open(p, unix.O_RDONLY|unix.O_CLOEXEC, 0)
	if err != nil {
		return "", err
	}
	defer unix.Close(fd)
	buf := make([]byte, unix.PathMax)
	if _, _, errno := unix.Syscall(unix.SYS_FCNTL, uintptr(fd), uintptr(unix.F_GETPATH), uintptr(unsafe.Pointer(&buf[0]))); errno != 0 {
		return "", fmt.Errorf("F_GETPATH %s: %w", p, errno)
	}
	return unix.ByteSliceToString(buf), nil
}

// SameVolume reports whether two paths are on the same filesystem.
func SameVolume(a, b string) bool {
	var sa, sb unix.Statfs_t
	if unix.Statfs(a, &sa) != nil || unix.Statfs(b, &sb) != nil {
		return false
	}
	return sa.Fsid == sb.Fsid
}
