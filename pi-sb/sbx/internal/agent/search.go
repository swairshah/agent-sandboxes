package agent

import (
	"bytes"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/bmatcuk/doublestar/v4"
	gitignore "github.com/sabhiram/go-gitignore"
)

// walker visits files under root like ripgrep --hidden: .gitignore files are
// honored at every level and .git is skipped.
type walker struct {
	root   string
	ignore []string // extra doublestar patterns relative to root
}

type ignoreLayer struct {
	base string // relative dir the .gitignore lives in
	m    *gitignore.GitIgnore
}

var errStop = errors.New("stop")

func (w walker) walk(visit func(abs, rel string) error) error {
	info, err := os.Stat(w.root)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return visit(w.root, filepath.Base(w.root))
	}
	err = w.walkDir(w.root, "", nil, visit)
	if errors.Is(err, errStop) {
		return nil
	}
	return err
}

func (w walker) walkDir(abs, rel string, layers []ignoreLayer, visit func(abs, rel string) error) error {
	if m, err := gitignore.CompileIgnoreFile(filepath.Join(abs, ".gitignore")); err == nil {
		layers = append(layers[:len(layers):len(layers)], ignoreLayer{base: rel, m: m})
	}
	ents, err := os.ReadDir(abs)
	if err != nil {
		return nil // unreadable directories are skipped, like rg does
	}
	for _, e := range ents {
		name := e.Name()
		if name == ".git" {
			continue
		}
		childRel := path.Join(rel, name)
		childAbs := filepath.Join(abs, name)
		isDir := e.IsDir()
		if w.ignored(childRel, isDir, layers) {
			continue
		}
		if isDir {
			if err := w.walkDir(childAbs, childRel, layers, visit); err != nil {
				return err
			}
			continue
		}
		if !e.Type().IsRegular() && e.Type()&fs.ModeSymlink == 0 {
			continue
		}
		if err := visit(childAbs, childRel); err != nil {
			return err
		}
	}
	return nil
}

func (w walker) ignored(rel string, isDir bool, layers []ignoreLayer) bool {
	for _, pat := range w.ignore {
		if ok, _ := doublestar.Match(pat, rel); ok {
			return true
		}
		if isDir {
			if ok, _ := doublestar.Match(pat, rel+"/"); ok {
				return true
			}
			if ok, _ := doublestar.Match(pat, rel+"/x"); ok {
				return true
			}
		}
	}
	for _, l := range layers {
		sub := rel
		if l.base != "" {
			sub = strings.TrimPrefix(rel, l.base+"/")
		}
		if isDir {
			sub += "/"
		}
		if l.m.MatchesPath(sub) {
			return true
		}
	}
	return false
}

// matchGlob matches a tool glob against a path relative to the search root.
// Patterns without a slash match the basename, as in fd and rg.
func matchGlob(pattern, rel string) bool {
	if strings.Contains(pattern, "/") {
		if ok, _ := doublestar.Match(pattern, rel); ok {
			return true
		}
		ok, _ := doublestar.Match("**/"+pattern, rel)
		return ok
	}
	ok, _ := doublestar.Match(pattern, path.Base(rel))
	return ok
}

func globOp(raw json.RawMessage) (map[string]any, error) {
	var p struct {
		Pattern string
		Path    string
		Limit   int
		Ignore  []string
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}
	if p.Limit <= 0 {
		p.Limit = 1000
	}
	var out []string
	err := walker{root: p.Path, ignore: p.Ignore}.walk(func(abs, rel string) error {
		if matchGlob(p.Pattern, rel) {
			out = append(out, abs)
			if len(out) >= p.Limit {
				return errStop
			}
		}
		return nil
	})
	if out == nil {
		out = []string{}
	}
	return map[string]any{"paths": out}, err
}

// grepLine is one output line: a match (sep ":") or context (sep "-").
type grepLine struct {
	Path string `json:"p"`
	Line int    `json:"n"`
	Sep  string `json:"s"`
	Text string `json:"t"`
}

func grepOp(raw json.RawMessage) (map[string]any, error) {
	var p struct {
		Pattern    string
		Path       string
		Glob       string
		IgnoreCase bool
		Literal    bool
		Context    int
		Limit      int
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}
	if p.Limit <= 0 {
		p.Limit = 100
	}
	expr := p.Pattern
	if p.Literal {
		expr = regexp.QuoteMeta(expr)
	}
	if p.IgnoreCase {
		expr = "(?i)" + expr
	}
	re, err := regexp.Compile(expr)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(p.Path)
	if err != nil {
		return nil, err
	}
	single := !info.IsDir()
	var lines []grepLine
	matches := 0
	limitReached := false
	err = walker{root: p.Path}.walk(func(abs, rel string) error {
		if p.Glob != "" && !matchGlob(p.Glob, rel) {
			return nil
		}
		data, err := os.ReadFile(abs)
		if err != nil || isBinary(data) {
			return nil
		}
		display := rel
		if single {
			display = filepath.Base(abs)
		}
		text := strings.ReplaceAll(string(data), "\r\n", "\n")
		fileLines := strings.Split(text, "\n")
		if len(fileLines) > 0 && fileLines[len(fileLines)-1] == "" {
			fileLines = fileLines[:len(fileLines)-1]
		}
		lastEmitted := -1
		for i, l := range fileLines {
			if !re.MatchString(l) {
				continue
			}
			matches++
			start, end := i, i
			if p.Context > 0 {
				start = max(0, i-p.Context)
				end = min(len(fileLines)-1, i+p.Context)
			}
			for j := max(start, lastEmitted+1); j <= end; j++ {
				sep := "-"
				if j == i || re.MatchString(fileLines[j]) {
					sep = ":"
				}
				lines = append(lines, grepLine{Path: display, Line: j + 1, Sep: sep, Text: fileLines[j]})
			}
			lastEmitted = end
			if matches >= p.Limit {
				limitReached = true
				return errStop
			}
		}
		return nil
	})
	if lines == nil {
		lines = []grepLine{}
	}
	return map[string]any{"lines": lines, "matches": matches, "limitReached": limitReached}, err
}

func isBinary(b []byte) bool {
	if len(b) > 8000 {
		b = b[:8000]
	}
	return bytes.IndexByte(b, 0) >= 0
}
