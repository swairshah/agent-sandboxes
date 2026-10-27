package engine

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/swairshah/pi-sb/sbx/internal/rpc"
)

// Summary is a checkpoint without its delta, for listings.
type Summary struct {
	ID    int               `json:"id"`
	Epoch int               `json:"epoch"`
	Time  time.Time         `json:"time"`
	Label string            `json:"label"`
	Kind  string            `json:"kind"`
	Meta  map[string]string `json:"meta,omitempty"`
	Stats Stats             `json:"stats"`
}

func Summarize(c *Checkpoint) *Summary {
	if c == nil {
		return nil
	}
	return &Summary{ID: c.ID, Epoch: c.Epoch, Time: c.Time, Label: c.Label, Kind: c.Kind, Meta: c.Meta, Stats: c.Stats}
}

// Handles reports whether op is an engine operation.
func Handles(op string) bool { return strings.HasPrefix(op, "ckpt.") || op == "sync.export" }

// Handle serves one engine request.
func (e *Engine) Handle(conn *rpc.Conn, req *rpc.Request) {
	var p struct {
		Label string
		Kind  string
		Meta  map[string]string
		Force bool
		Ckpt  int   `json:"ckpt"`
		IDs   []int `json:"ids"`
	}
	json.Unmarshal(req.Params, &p)
	res := map[string]any{}
	var err error
	switch req.Op {
	case "ckpt.ready":
		err = e.Ready()
		res["epoch"] = e.Epoch()
	case "ckpt.create":
		if p.Kind == "" {
			p.Kind = "auto"
		}
		var c *Checkpoint
		c, err = e.Checkpoint(p.Label, p.Kind, p.Meta, p.Force)
		res["ckpt"] = Summarize(c)
	case "ckpt.list":
		if err = e.Ready(); err == nil {
			e.mu.Lock()
			list := make([]*Summary, 0, len(e.store.ckpts))
			for _, c := range e.store.ckpts {
				list = append(list, Summarize(c))
			}
			e.mu.Unlock()
			res["ckpts"] = list
			res["epoch"] = e.Epoch()
		}
	case "ckpt.restore":
		var c *Checkpoint
		c, err = e.Restore(p.Ckpt)
		res["ckpt"] = Summarize(c)
	case "ckpt.changed":
		var paths []string
		paths, err = e.Changed(p.Ckpt)
		res["paths"] = paths
		res["whole"] = paths == nil && err == nil
	case "ckpt.delete":
		var n int
		n, err = e.Delete(p.IDs)
		res["deleted"] = n
	case "ckpt.usage":
		res["bytes"], res["files"] = e.store.Usage()
	case "sync.export":
		res, err = e.Export()
	default:
		err = fmt.Errorf("unknown op %q", req.Op)
	}
	if err != nil {
		conn.Error(req.ID, err)
		return
	}
	conn.Reply(req.ID, res)
}

// Usage returns the logical size and file count of everything the store
// holds. On APFS most of it shares blocks with the live files.
func (s *Store) Usage() (int64, int) {
	var bytes int64
	files := 0
	filepath.WalkDir(filepath.Join(s.Dir, "epochs"), func(p string, d fs.DirEntry, err error) error {
		if err == nil && d.Type().IsRegular() {
			if info, err := d.Info(); err == nil {
				bytes += info.Size()
				files++
			}
		}
		return nil
	})
	return bytes, files
}

// Export packs every path that changed in this epoch (relative to root 0, the
// workspace) into a tar.gz, and lists deleted paths. Remote boxes use it to
// pull the agent's work back to the host.
func (e *Engine) Export() (map[string]any, error) {
	if _, err := e.Checkpoint("before export", "auto", nil, false); err != nil {
		return nil, err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	first := e.store.epochCheckpoints(e.epoch, 1<<31)
	if len(first) == 0 {
		return nil, fmt.Errorf("no checkpoints in this epoch")
	}
	changed := map[string]bool{}
	for _, c := range first {
		for rel := range c.entries(0) {
			changed[rel] = true
		}
	}
	rels := make([]string, 0, len(changed))
	for r := range changed {
		rels = append(rels, r)
	}
	sort.Strings(rels)
	root := e.roots[0].Path
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	var deleted []string
	var done []string
	files := 0
next:
	for _, rel := range rels {
		for _, d := range done {
			if isUnder(rel, d) {
				continue next
			}
		}
		abs := filepath.Join(root, filepath.FromSlash(rel))
		info, err := os.Lstat(abs)
		if err != nil {
			deleted = append(deleted, rel)
			continue
		}
		if info.IsDir() {
			// Paths the host has (the base is what was uploaded) but this
			// directory no longer contains.
			base := e.store.abs(filepath.Join(e.store.basePath(e.epoch, 0), filepath.FromSlash(rel)))
			filepath.WalkDir(base, func(p string, d fs.DirEntry, err error) error {
				if err != nil || p == base {
					return nil
				}
				r, _ := filepath.Rel(e.store.abs(e.store.basePath(e.epoch, 0)), p)
				if _, err := os.Lstat(filepath.Join(root, r)); err != nil {
					deleted = append(deleted, filepath.ToSlash(r))
					if d.IsDir() {
						return filepath.SkipDir
					}
				}
				return nil
			})
		}
		err = filepath.WalkDir(abs, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			info, err := d.Info()
			if err != nil {
				return nil
			}
			r, _ := filepath.Rel(root, p)
			link := ""
			if d.Type()&fs.ModeSymlink != 0 {
				link, _ = os.Readlink(p)
			}
			hdr, err := tar.FileInfoHeader(info, link)
			if err != nil {
				return nil
			}
			hdr.Name = filepath.ToSlash(r)
			if err := tw.WriteHeader(hdr); err != nil {
				return err
			}
			if info.Mode().IsRegular() {
				f, err := os.Open(p)
				if err != nil {
					return nil
				}
				defer f.Close()
				io.Copy(tw, f)
				files++
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
		done = append(done, rel)
	}
	tw.Close()
	gz.Close()
	return map[string]any{"tar": buf.Bytes(), "deleted": deleted, "files": files, "paths": len(rels)}, nil
}

// ParseIDs turns "3", "3-7", "3,5,9" and "all" into checkpoint IDs.
func ParseIDs(args []string, all []int) ([]int, error) {
	var out []int
	for _, a := range args {
		for _, part := range strings.Split(a, ",") {
			switch {
			case part == "all":
				out = append(out, all...)
			case strings.Contains(part, "-"):
				lo, hi, _ := strings.Cut(part, "-")
				l, err1 := strconv.Atoi(lo)
				h, err2 := strconv.Atoi(hi)
				if err1 != nil || err2 != nil || l > h {
					return nil, fmt.Errorf("bad range %q", part)
				}
				for _, id := range all {
					if id >= l && id <= h {
						out = append(out, id)
					}
				}
			default:
				n, err := strconv.Atoi(strings.TrimPrefix(part, "#"))
				if err != nil {
					return nil, fmt.Errorf("bad checkpoint id %q", part)
				}
				out = append(out, n)
			}
		}
	}
	return out, nil
}

// DeleteOffline deletes checkpoints from a store no engine is using.
func (s *Store) DeleteOffline(ids []int) int {
	n := s.deleteCheckpoints(ids, -1, nil)
	s.gc(-1)
	return n
}
