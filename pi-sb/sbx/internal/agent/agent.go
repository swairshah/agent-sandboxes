// Package agent executes pi's tool operations: file reads and writes, shell
// commands, grep and glob. It runs inside the sandbox, so the sandbox, not this
// code, decides what it may touch.
package agent

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"syscall"
	"time"

	"github.com/swairshah/pi-sb/sbx/internal/rpc"
)

const Version = "0.1.0"

// Agent serves tool operations on a connection.
type Agent struct {
	Conn  *rpc.Conn
	Shell string   // shell used for exec, e.g. /bin/bash
	Env   []string // base environment for commands

	mu    sync.Mutex
	procs map[int64]*proc
}

type proc struct {
	cmd     *exec.Cmd
	aborted bool
}

func New(conn *rpc.Conn, shell string, env []string) *Agent {
	return &Agent{Conn: conn, Shell: shell, Env: env, procs: map[int64]*proc{}}
}

// Handles reports whether op is an agent operation.
func Handles(op string) bool {
	switch op {
	case "hello", "exec", "cancel", "read", "write", "mkdir", "stat", "access", "lsdir", "glob", "grep":
		return true
	}
	return false
}

// Handle runs one request. Long-running ops should be called in a goroutine.
func (a *Agent) Handle(req *rpc.Request) {
	var err error
	var res map[string]any
	switch req.Op {
	case "hello":
		home, _ := os.UserHomeDir()
		res = map[string]any{"version": Version, "os": runtime.GOOS, "arch": runtime.GOARCH, "home": home, "pid": os.Getpid()}
	case "exec":
		res, err = a.exec(req)
	case "cancel":
		var p struct{ Target int64 }
		json.Unmarshal(req.Params, &p)
		a.kill(p.Target, true)
	case "read":
		var p struct{ Path string }
		json.Unmarshal(req.Params, &p)
		var b []byte
		b, err = os.ReadFile(p.Path)
		res = map[string]any{"data": b}
	case "write":
		var p struct {
			Path string
			Data []byte
		}
		json.Unmarshal(req.Params, &p)
		mode := fs.FileMode(0o644)
		if info, e := os.Stat(p.Path); e == nil {
			mode = info.Mode().Perm()
		}
		err = os.WriteFile(p.Path, p.Data, mode)
	case "mkdir":
		var p struct{ Path string }
		json.Unmarshal(req.Params, &p)
		err = os.MkdirAll(p.Path, 0o755)
	case "stat":
		var p struct{ Path string }
		json.Unmarshal(req.Params, &p)
		info, e := os.Stat(p.Path)
		if errors.Is(e, fs.ErrNotExist) {
			res = map[string]any{"exists": false}
		} else if e != nil {
			err = e
		} else {
			res = map[string]any{"exists": true, "dir": info.IsDir(), "size": info.Size(), "mode": uint32(info.Mode().Perm()),
				"mtime": info.ModTime().UnixMilli()}
		}
	case "access":
		var p struct {
			Path  string
			Write bool
		}
		json.Unmarshal(req.Params, &p)
		err = access(p.Path, p.Write)
	case "lsdir":
		var p struct{ Path string }
		json.Unmarshal(req.Params, &p)
		res, err = lsdir(p.Path)
	case "glob":
		res, err = globOp(req.Params)
	case "grep":
		res, err = grepOp(req.Params)
	default:
		err = fmt.Errorf("unknown op %q", req.Op)
	}
	if err != nil {
		a.Conn.Error(req.ID, err)
		return
	}
	a.Conn.Reply(req.ID, res)
}

func access(p string, write bool) error {
	f, err := os.Open(p)
	if err != nil {
		return err
	}
	f.Close()
	if write {
		f, err := os.OpenFile(p, os.O_WRONLY, 0)
		if err != nil {
			return err
		}
		f.Close()
	}
	return nil
}

func lsdir(p string) (map[string]any, error) {
	ents, err := os.ReadDir(p)
	if err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(ents))
	for _, e := range ents {
		dir := e.IsDir()
		if e.Type()&fs.ModeSymlink != 0 {
			if info, err := os.Stat(filepath.Join(p, e.Name())); err == nil {
				dir = info.IsDir()
			}
		}
		out = append(out, map[string]any{"n": e.Name(), "d": dir})
	}
	return map[string]any{"entries": out}, nil
}

// exec runs a shell command in its own process group, streaming combined
// output. Timeout and cancel kill the whole group.
func (a *Agent) exec(req *rpc.Request) (map[string]any, error) {
	var p struct {
		Cmd     string
		Cwd     string
		Env     map[string]string
		Timeout float64
	}
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return nil, err
	}
	cmd := exec.Command(a.Shell, "-c", p.Cmd)
	cmd.Dir = p.Cwd
	cmd.Env = append([]string{}, a.Env...)
	for k, v := range p.Env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	// A background job that keeps stdout open must not hang the call.
	cmd.WaitDelay = time.Second
	w := &streamWriter{conn: a.Conn, id: req.ID}
	cmd.Stdout = w
	cmd.Stderr = w
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	pr := &proc{cmd: cmd}
	a.mu.Lock()
	a.procs[req.ID] = pr
	a.mu.Unlock()
	var timedOut bool
	var timer *time.Timer
	if p.Timeout > 0 {
		timer = time.AfterFunc(time.Duration(p.Timeout*float64(time.Second)), func() {
			timedOut = true
			a.kill(req.ID, false)
		})
	}
	err := cmd.Wait()
	if timer != nil {
		timer.Stop()
	}
	a.mu.Lock()
	delete(a.procs, req.ID)
	aborted := pr.aborted
	a.mu.Unlock()
	res := map[string]any{"exit": nil}
	var ee *exec.ExitError
	switch {
	case err == nil:
		res["exit"] = 0
	case errors.As(err, &ee):
		if ee.Exited() {
			res["exit"] = ee.ExitCode()
		}
	default:
		return nil, err
	}
	if timedOut {
		res["timedOut"] = true
	}
	if aborted {
		res["aborted"] = true
	}
	return res, nil
}

func (a *Agent) kill(id int64, abort bool) {
	a.mu.Lock()
	pr := a.procs[id]
	if pr != nil && abort {
		pr.aborted = true
	}
	a.mu.Unlock()
	if pr != nil && pr.cmd.Process != nil {
		syscall.Kill(-pr.cmd.Process.Pid, syscall.SIGKILL)
	}
}

// KillAll kills every running command, on shutdown.
func (a *Agent) KillAll() {
	a.mu.Lock()
	ids := make([]int64, 0, len(a.procs))
	for id := range a.procs {
		ids = append(ids, id)
	}
	a.mu.Unlock()
	for _, id := range ids {
		a.kill(id, true)
	}
}

type streamWriter struct {
	conn *rpc.Conn
	id   int64
}

func (w *streamWriter) Write(b []byte) (int, error) {
	// exec.Cmd reuses b after Write returns; Data encodes it immediately.
	if err := w.conn.Data(w.id, b); err != nil {
		return 0, err
	}
	return len(b), nil
}
