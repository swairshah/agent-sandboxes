// Command sbx runs pi's tools inside a sandbox and checkpoints what they do.
//
//	sbx host --config-b64 <json>   local box: checkpoint engine + Seatbelt agent (used by pi)
//	sbx serve [--store DIR --root P]  agent on stdio; with --store, also the engine (remote boxes)
//	sbx ckpt ls|diff|restore|rm   manage a box's checkpoints from a terminal
//	sbx boxes                     list boxes
//	sbx shell                     interactive shell inside the cwd's box
package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"syscall"
	"text/tabwriter"
	"time"

	"github.com/swairshah/pi-sb/sbx/internal/agent"
	"github.com/swairshah/pi-sb/sbx/internal/engine"
	"github.com/swairshah/pi-sb/sbx/internal/rpc"
	"github.com/swairshah/pi-sb/sbx/internal/sandbox"
)

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	var err error
	switch os.Args[1] {
	case "host":
		err = runHost(os.Args[2:])
	case "serve":
		err = runServe(os.Args[2:])
	case "ckpt":
		err = runCkpt(os.Args[2:])
	case "boxes":
		err = runBoxes(os.Args[2:])
	case "shell":
		err = runShell(os.Args[2:])
	case "profile":
		err = runProfile(os.Args[2:])
	case "version":
		fmt.Println(agent.Version, runtime.GOOS+"/"+runtime.GOARCH)
	default:
		usage()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "sbx:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `usage:
  sbx ckpt ls [--cwd DIR]             list checkpoints of DIR's box
  sbx ckpt diff ID [--cwd DIR]        paths a restore to ID would change
  sbx ckpt restore ID [--cwd DIR]     restore DIR to checkpoint ID
  sbx ckpt rm IDS... [--cwd DIR]      delete checkpoints: 5  3-9  2,4  all  (--keep N keeps the newest N)
  sbx boxes [--rm ID]                 list boxes (or delete one)
  sbx shell [--cwd DIR]               interactive shell inside DIR's box
  sbx profile [--cwd DIR]             print the Seatbelt profile
`)
	os.Exit(2)
}

// loadConfig reads the host config: --config-b64 from pi, or the user's
// ~/.pi/agent/sb.json for terminal commands.
func loadConfig(b64, cwd string) (*sandbox.Config, error) {
	c := &sandbox.Config{}
	if b64 != "" {
		raw, err := base64.StdEncoding.DecodeString(b64)
		if err != nil {
			return nil, err
		}
		if err := json.Unmarshal(raw, c); err != nil {
			return nil, err
		}
	} else {
		home, _ := os.UserHomeDir()
		if raw, err := os.ReadFile(filepath.Join(home, ".pi/agent/sb.json")); err == nil {
			var file struct {
				sandbox.Config
				Local *sandbox.Config `json:"local"`
			}
			if err := json.Unmarshal(raw, &file); err != nil {
				return nil, fmt.Errorf("~/.pi/agent/sb.json: %w", err)
			}
			*c = file.Config
			if file.Local != nil {
				*c = *file.Local
			}
		}
	}
	if cwd != "" {
		c.Cwd = cwd
	}
	if c.Cwd == "" {
		c.Cwd, _ = os.Getwd()
	}
	if c.Root == "" {
		c.Root = "~/.pi/sb"
	}
	if c.Shell == "" {
		c.Shell = "/bin/bash"
	}
	if c.Network == "" {
		c.Network = "on"
	}
	return c, nil
}

func engineOptions(c *sandbox.Config, watcher string) engine.Options {
	return engine.Options{
		Watcher:  watcher,
		KeepLast: c.Checkpoint.KeepLast,
		KeepDays: c.Checkpoint.KeepDays,
		Log:      func(f string, a ...any) { fmt.Fprintf(os.Stderr, "sbx: "+f+"\n", a...) },
	}
}

func roots(c *sandbox.Config, b *sandbox.Box) []engine.RootSpec {
	return []engine.RootSpec{
		{Path: c.Cwd, Excludes: c.Checkpoint.ExcludeCwd},
		{Path: b.Home, Excludes: c.Checkpoint.ExcludeHome},
	}
}

// lock takes an exclusive lock on the box so two engines never share a store.
func lock(store string) (*os.File, error) {
	f, err := os.OpenFile(filepath.Join(store, "lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		pid, _ := os.ReadFile(filepath.Join(store, "lock.pid"))
		return nil, fmt.Errorf("box is in use (pid %s); manage it with /sb inside that pi session", strings.TrimSpace(string(pid)))
	}
	os.WriteFile(filepath.Join(store, "lock.pid"), []byte(fmt.Sprint(os.Getpid())), 0o600)
	return f, nil
}

// runHost is the local box: it owns the checkpoint engine (outside the
// sandbox) and proxies tool operations to `sbx serve` running under Seatbelt.
func runHost(args []string) error {
	fs := flag.NewFlagSet("host", flag.ExitOnError)
	b64 := fs.String("config-b64", "", "base64 JSON config")
	fs.Parse(args)
	c, err := loadConfig(*b64, "")
	if err != nil {
		return err
	}
	box, err := sandbox.Prepare(c)
	if err != nil {
		return err
	}
	lk, err := lock(box.Store)
	if err != nil {
		return err
	}
	defer lk.Close()
	exe, _ := os.Executable()
	exe, _ = filepath.EvalSymlinks(exe)

	eng, err := engine.Open(box.Store, roots(c, box), engineOptions(c, "fsevents"))
	if err != nil {
		return err
	}
	defer eng.Close()

	profile := sandbox.Profile(c, box, exe)
	child := sandbox.Command(profile, []string{exe, "serve", "--shell", c.Shell})
	child.Env = box.Env(c)
	child.Dir = c.Cwd
	child.Stderr = os.Stderr
	childIn, _ := child.StdinPipe()
	childOut, _ := child.StdoutPipe()
	if err := child.Start(); err != nil {
		return fmt.Errorf("starting sandbox: %w", err)
	}

	conn := rpc.NewConn(os.Stdin, os.Stdout)
	conn.Send(map[string]any{"ev": "box", "box": box.ID, "dir": box.Dir, "home": box.Home, "tmp": box.Tmp,
		"store": box.Store, "cwd": c.Cwd, "pid": os.Getpid()})

	done := make(chan struct{})
	go func() {
		r := bufio.NewReaderSize(childOut, 1<<20)
		for {
			line, err := r.ReadBytes('\n')
			if len(line) > 0 {
				conn.SendRaw(line)
			}
			if err != nil {
				break
			}
		}
		close(done)
	}()

	var childMu sync.Mutex
	for {
		req, line, err := conn.Read()
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			continue
		}
		if engine.Handles(req.Op) {
			go eng.Handle(conn, req)
			continue
		}
		childMu.Lock()
		_, werr := childIn.Write(line)
		childMu.Unlock()
		if werr != nil {
			conn.Error(req.ID, fmt.Errorf("sandbox is gone: %w", werr))
		}
	}
	childIn.Close()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		child.Process.Kill()
	}
	child.Wait()
	return nil
}

// runServe is the agent. Locally it runs under Seatbelt with no engine; in a
// remote box it also runs the engine, since the whole box is disposable.
func runServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	shell := fs.String("shell", "", "shell for exec")
	store := fs.String("store", "", "checkpoint store (enables the engine)")
	keep := fs.Int("keep-last", 0, "checkpoints to keep")
	var rootList multiFlag
	var excludes multiFlag
	fs.Var(&rootList, "root", "checkpointed root (repeatable)")
	fs.Var(&excludes, "exclude", "excluded path under the first root (repeatable)")
	fs.Parse(args)
	if *shell == "" {
		*shell = "/bin/bash"
		if _, err := os.Stat(*shell); err != nil {
			*shell = "/bin/sh"
		}
	}
	conn := rpc.NewConn(os.Stdin, os.Stdout)
	ag := agent.New(conn, *shell, os.Environ())
	var eng *engine.Engine
	if *store != "" {
		var specs []engine.RootSpec
		for i, r := range rootList {
			spec := engine.RootSpec{Path: r}
			if i == 0 {
				spec.Excludes = excludes
			}
			specs = append(specs, spec)
		}
		var err error
		eng, err = engine.Open(*store, specs, engine.Options{Watcher: "walk", KeepLast: *keep,
			Log: func(f string, a ...any) { fmt.Fprintf(os.Stderr, "sbx: "+f+"\n", a...) }})
		if err != nil {
			return err
		}
		defer eng.Close()
	}
	signal.Ignore(syscall.SIGPIPE)
	for {
		req, _, err := conn.Read()
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			continue
		}
		switch {
		case agent.Handles(req.Op):
			go ag.Handle(req)
		case eng != nil && engine.Handles(req.Op):
			go eng.Handle(conn, req)
		default:
			conn.Error(req.ID, fmt.Errorf("unknown op %q", req.Op))
		}
	}
	ag.KillAll()
	return nil
}

type multiFlag []string

func (m *multiFlag) String() string     { return strings.Join(*m, ",") }
func (m *multiFlag) Set(v string) error { *m = append(*m, v); return nil }

func boxFor(cwd string) (*sandbox.Config, *sandbox.Box, error) {
	c, err := loadConfig("", cwd)
	if err != nil {
		return nil, nil, err
	}
	b, err := sandbox.Prepare(c)
	return c, b, err
}

func runCkpt(args []string) error {
	if len(args) == 0 {
		usage()
	}
	sub := args[0]
	fs := flag.NewFlagSet("ckpt", flag.ExitOnError)
	cwd := fs.String("cwd", "", "project directory (default: current)")
	keep := fs.Int("keep", -1, "with rm: keep the newest N checkpoints")
	// Accept flags before or after positional arguments.
	var pos []string
	rest := args[1:]
	for len(rest) > 0 {
		fs.Parse(rest)
		rest = fs.Args()
		if len(rest) > 0 {
			pos = append(pos, rest[0])
			rest = rest[1:]
		}
	}
	c, box, err := boxFor(*cwd)
	if err != nil {
		return err
	}
	switch sub {
	case "ls", "list":
		s, err := engine.OpenStore(box.Store, nil)
		if err != nil {
			return err
		}
		printList(s.Checkpoints())
		bytes, files := s.Usage()
		fmt.Printf("\nstore: %s (%d files, %s logical; clones share blocks with live files)\n", box.Store, files, human(bytes))
		return nil
	case "rm", "delete":
		lk, err := lock(box.Store)
		if err != nil {
			return err
		}
		defer lk.Close()
		s, err := engine.OpenStore(box.Store, nil)
		if err != nil {
			return err
		}
		var all []int
		for _, ck := range s.Checkpoints() {
			all = append(all, ck.ID)
		}
		var ids []int
		if *keep >= 0 {
			if len(all) > *keep {
				ids = all[:len(all)-*keep]
			}
		} else {
			if ids, err = engine.ParseIDs(pos, all); err != nil {
				return err
			}
		}
		n := s.DeleteOffline(ids)
		s.EmptyTrash()
		fmt.Printf("deleted %d checkpoint(s)\n", n)
		return nil
	case "diff", "restore":
		if len(pos) != 1 {
			return fmt.Errorf("usage: sbx ckpt %s ID", sub)
		}
		ids, err := engine.ParseIDs(pos, nil)
		if err != nil || len(ids) != 1 {
			return fmt.Errorf("bad checkpoint id %q", pos[0])
		}
		lk, err := lock(box.Store)
		if err != nil {
			return err
		}
		defer lk.Close()
		if sub == "diff" {
			s, err := engine.OpenStore(box.Store, nil)
			if err != nil {
				return err
			}
			return printOfflineDiff(s, ids[0])
		}
		// Opening an engine starts a new epoch whose base is the current
		// state, so this restore can be undone too.
		eng, err := engine.Open(box.Store, roots(c, box), engineOptions(c, "fsevents"))
		if err != nil {
			return err
		}
		defer eng.Close()
		t := time.Now()
		ck, err := eng.Restore(ids[0])
		if err != nil {
			return err
		}
		fmt.Printf("restored #%d in %s (now #%d)\n", ids[0], time.Since(t).Round(time.Millisecond), ck.ID)
		return nil
	}
	usage()
	return nil
}

func printOfflineDiff(s *engine.Store, id int) error {
	ck := s.Get(id)
	if ck == nil {
		return fmt.Errorf("no checkpoint #%d", id)
	}
	seen := map[string]bool{}
	for _, c := range s.Checkpoints() {
		if c.Epoch == ck.Epoch && c.ID > ck.ID {
			for r, m := range c.Delta {
				for rel, e := range m {
					key := r + ":" + rel
					if !seen[key] {
						seen[key] = true
						root := s.Info.Roots[atoi(r)].Path
						fmt.Printf("%s  %s\n", e.T, filepath.Join(root, rel))
					}
				}
			}
		}
	}
	return nil
}

func atoi(s string) int {
	n := 0
	fmt.Sscan(s, &n)
	return n
}

func printList(cks []*engine.Checkpoint) {
	tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "ID\tSESSION\tTIME\tPATHS\tMS\tLABEL")
	for _, c := range cks {
		fmt.Fprintf(tw, "#%d\t%d\t%s\t%d\t%.1f\t%s\n", c.ID, c.Epoch, c.Time.Local().Format("Jan 02 15:04:05"),
			c.Stats.Paths, c.Stats.Millis, c.Label)
	}
	tw.Flush()
}

func runBoxes(args []string) error {
	fs := flag.NewFlagSet("boxes", flag.ExitOnError)
	rm := fs.String("rm", "", "delete this box (home, tmp and checkpoints)")
	fs.Parse(args)
	c, err := loadConfig("", "/")
	if err != nil {
		return err
	}
	home, _ := os.UserHomeDir()
	root := c.Root
	if strings.HasPrefix(root, "~/") {
		root = filepath.Join(home, root[2:])
	}
	dir := filepath.Join(root, "boxes")
	if *rm != "" {
		target := filepath.Join(dir, filepath.Base(*rm))
		if _, err := os.Stat(target); err != nil {
			return err
		}
		lk, err := lock(filepath.Join(target, "store"))
		if err != nil {
			return err
		}
		lk.Close()
		trash := filepath.Join(root, "trash")
		os.MkdirAll(trash, 0o700)
		dst := filepath.Join(trash, fmt.Sprintf("%s-%d", filepath.Base(target), time.Now().UnixNano()))
		if err := os.Rename(target, dst); err != nil {
			return err
		}
		fmt.Println("deleted box", filepath.Base(target))
		return os.RemoveAll(dst)
	}
	ents, _ := os.ReadDir(dir)
	tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "BOX\tCHECKPOINTS\tLAST USED\tCWD")
	type row struct {
		id, cwd string
		n       int
		last    time.Time
	}
	var rows []row
	for _, e := range ents {
		var meta struct{ Cwd string }
		b, _ := os.ReadFile(filepath.Join(dir, e.Name(), "box.json"))
		json.Unmarshal(b, &meta)
		r := row{id: e.Name(), cwd: meta.Cwd}
		if s, err := engine.OpenStore(filepath.Join(dir, e.Name(), "store"), nil); err == nil {
			r.n = len(s.Checkpoints())
			if h := s.Head(); h != nil {
				r.last = h.Time
			}
		}
		rows = append(rows, r)
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].last.After(rows[j].last) })
	for _, r := range rows {
		fmt.Fprintf(tw, "%s\t%d\t%s\t%s\n", r.id, r.n, r.last.Local().Format("Jan 02 15:04"), r.cwd)
	}
	return tw.Flush()
}

// runShell opens an interactive shell in the box, checkpointing before and
// after.
func runShell(args []string) error {
	fs := flag.NewFlagSet("shell", flag.ExitOnError)
	cwd := fs.String("cwd", "", "project directory")
	fs.Parse(args)
	c, box, err := boxFor(*cwd)
	if err != nil {
		return err
	}
	lk, err := lock(box.Store)
	if err != nil {
		return err
	}
	defer lk.Close()
	exe, _ := os.Executable()
	eng, err := engine.Open(box.Store, roots(c, box), engineOptions(c, "fsevents"))
	if err != nil {
		return err
	}
	defer eng.Close()
	if err := eng.Ready(); err != nil {
		return err
	}
	cmd := sandbox.Command(sandbox.Profile(c, box, exe), []string{c.Shell, "-i"})
	cmd.Env = append(box.Env(c), "PS1=(sbx) \\w \\$ ")
	cmd.Dir = c.Cwd
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	signal.Ignore(syscall.SIGINT)
	cmd.Run()
	ck, err := eng.Checkpoint("after sbx shell", "manual", nil, false)
	if err == nil && ck != nil {
		fmt.Printf("checkpoint #%d (%d paths)\n", ck.ID, ck.Stats.Paths)
	}
	return err
}

func runProfile(args []string) error {
	fs := flag.NewFlagSet("profile", flag.ExitOnError)
	cwd := fs.String("cwd", "", "project directory")
	fs.Parse(args)
	c, box, err := boxFor(*cwd)
	if err != nil {
		return err
	}
	exe, _ := os.Executable()
	fmt.Print(sandbox.Profile(c, box, exe))
	return nil
}

func human(n int64) string {
	switch {
	case n > 1<<30:
		return fmt.Sprintf("%.1f GB", float64(n)/(1<<30))
	case n > 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	case n > 1<<10:
		return fmt.Sprintf("%.1f KB", float64(n)/(1<<10))
	}
	return fmt.Sprintf("%d B", n)
}
