package clone

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

var errNoTreeClone = errors.New("no tree clone on linux")

// Linux has no tree clone; copyTree reflinks each file instead.
func cloneNative(src, dst string) error {
	info, err := os.Lstat(src)
	if err != nil {
		return err
	}
	if info.Mode().IsRegular() {
		return cloneFile(src, dst)
	}
	return errNoTreeClone
}

func cloneFile(src, dst string) error {
	info, err := os.Stat(src)
	if err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, info.Mode().Perm())
	if err != nil {
		return err
	}
	if err := unix.IoctlFileClone(int(out.Fd()), int(in.Fd())); err != nil {
		out.Close()
		os.Remove(dst)
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Chtimes(dst, info.ModTime(), info.ModTime())
}
