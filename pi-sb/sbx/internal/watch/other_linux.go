package watch

import (
	"path/filepath"

	"golang.org/x/sys/unix"
)

func Canonical(p string) (string, error) {
	p, err := filepath.EvalSymlinks(p)
	if err != nil {
		return "", err
	}
	return filepath.Abs(p)
}

func SameVolume(a, b string) bool {
	var sa, sb unix.Statfs_t
	if unix.Statfs(a, &sa) != nil || unix.Statfs(b, &sb) != nil {
		return false
	}
	return sa.Fsid == sb.Fsid
}
