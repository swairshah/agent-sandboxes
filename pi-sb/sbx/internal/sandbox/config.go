// Package sandbox prepares a local box (private home, tmp and checkpoint
// store) and the macOS Seatbelt profile that confines the agent to it.
package sandbox

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Config is what the pi extension sends to `sbx host`.
type Config struct {
	Cwd     string            `json:"cwd"`
	Root    string            `json:"root"`    // ~/.pi/sb; boxes live in Root/boxes/<id>
	Read    []string          `json:"read"`    // extra read-only paths
	Write   []string          `json:"write"`   // extra read-write paths (not checkpointed)
	Deny    []string          `json:"deny"`    // paths unreadable even inside allowed ones
	Protect []string          `json:"protect"` // cwd-relative paths the agent may not write
	Network string            `json:"network"` // "on" or "local"
	Env     map[string]string `json:"env"`
	Seed    []string          `json:"seed"` // files copied into the box home once
	Shell   string            `json:"shell"`

	Checkpoint struct {
		ExcludeCwd  []string `json:"excludeCwd"`
		ExcludeHome []string `json:"excludeHome"`
		KeepLast    int      `json:"keepLast"`
		KeepDays    int      `json:"keepDays"`
	} `json:"checkpoint"`
}

// Box is a prepared sandbox directory.
type Box struct {
	ID    string
	Dir   string
	Home  string
	Tmp   string
	Store string
}

// BoxID names the box for a working directory: basename plus a short hash.
func BoxID(cwd string) string {
	h := sha256.Sum256([]byte(cwd))
	base := strings.Map(func(r rune) rune {
		if r == '/' || r == ' ' || r == ':' {
			return '_'
		}
		return r
	}, filepath.Base(cwd))
	return base + "-" + hex.EncodeToString(h[:4])
}

// Prepare validates the config and creates the box directories.
func Prepare(c *Config) (*Box, error) {
	home, _ := os.UserHomeDir()
	cwd, err := filepath.EvalSymlinks(c.Cwd)
	if err != nil {
		return nil, err
	}
	c.Cwd = cwd
	root, err := filepath.Abs(expand(c.Root, home))
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, err
	}
	root, _ = filepath.EvalSymlinks(root)
	switch {
	case cwd == "/" || cwd == home:
		return nil, fmt.Errorf("refusing to sandbox %s: pick a project directory", cwd)
	case within(root, cwd):
		return nil, fmt.Errorf("refusing to sandbox %s: it contains the sandbox store %s", cwd, root)
	case within(cwd, root):
		return nil, fmt.Errorf("refusing to sandbox %s: it is inside the sandbox store", cwd)
	}
	id := BoxID(cwd)
	b := &Box{ID: id, Dir: filepath.Join(root, "boxes", id)}
	b.Home = filepath.Join(b.Dir, "home")
	b.Tmp = filepath.Join(b.Dir, "tmp")
	b.Store = filepath.Join(b.Dir, "store")
	for _, d := range []string{b.Home, b.Tmp, b.Store} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return nil, err
		}
	}
	meta, _ := json.Marshal(map[string]string{"cwd": cwd})
	os.WriteFile(filepath.Join(b.Dir, "box.json"), meta, 0o600)
	for _, s := range c.Seed {
		src := expand(s, home)
		rel, err := filepath.Rel(home, src)
		if err != nil || strings.HasPrefix(rel, "..") {
			continue
		}
		dst := filepath.Join(b.Home, rel)
		if _, err := os.Stat(dst); err == nil {
			continue
		}
		if data, err := os.ReadFile(src); err == nil {
			os.MkdirAll(filepath.Dir(dst), 0o700)
			os.WriteFile(dst, data, 0o600)
		}
	}
	for i, p := range c.Read {
		c.Read[i] = expand(p, home)
	}
	for i, p := range c.Write {
		c.Write[i] = expand(p, home)
	}
	for i, p := range c.Deny {
		c.Deny[i] = expand(p, home)
	}
	return b, nil
}

// Env is the complete environment for commands in the box. Nothing from the
// host environment leaks in except a few harmless variables.
func (b *Box) Env(c *Config) []string {
	home, _ := os.UserHomeDir()
	path := strings.Join([]string{
		filepath.Join(b.Home, ".local/bin"),
		filepath.Join(b.Home, ".npm-global/bin"),
		filepath.Join(b.Home, ".cargo/bin"),
		filepath.Join(b.Home, "go/bin"),
		os.Getenv("PATH"),
	}, ":")
	env := map[string]string{
		"HOME":              b.Home,
		"TMPDIR":            b.Tmp + "/",
		"PATH":              path,
		"SHELL":             c.Shell,
		"USER":              os.Getenv("USER"),
		"LOGNAME":           os.Getenv("USER"),
		"LANG":              orDefault(os.Getenv("LANG"), "en_US.UTF-8"),
		"TERM":              orDefault(os.Getenv("TERM"), "xterm-256color"),
		"NPM_CONFIG_PREFIX": filepath.Join(b.Home, ".npm-global"),
		"CARGO_HOME":        filepath.Join(b.Home, ".cargo"),
		"GOPATH":            filepath.Join(b.Home, "go"),
		"PI_SANDBOX":        "1",
		"PI_SANDBOX_CWD":    c.Cwd,
	}
	if _, err := os.Stat(filepath.Join(home, ".rustup")); err == nil {
		env["RUSTUP_HOME"] = filepath.Join(home, ".rustup")
	}
	for k, v := range c.Env {
		env[k] = v
	}
	out := make([]string, 0, len(env))
	for k, v := range env {
		out = append(out, k+"="+v)
	}
	return out
}

func expand(p, home string) string {
	if p == "~" {
		return home
	}
	if strings.HasPrefix(p, "~/") {
		return filepath.Join(home, p[2:])
	}
	return p
}

// within reports whether p is dir or inside it.
func within(p, dir string) bool {
	return p == dir || strings.HasPrefix(p, dir+"/")
}

func orDefault(v, d string) string {
	if v == "" {
		return d
	}
	return v
}
