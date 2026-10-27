// Package clone makes copy-on-write copies of files and directory trees.
//
// On APFS a whole tree is cloned with one clonefile(2) call. On Linux each file
// is cloned with FICLONE when the filesystem supports reflinks, and copied
// otherwise.
package clone

import (
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// Tree copies src (a file, symlink or directory) to dst. dst must not exist.
func Tree(src, dst string) error {
	if err := cloneNative(src, dst); err == nil {
		return nil
	}
	return copyTree(src, dst)
}

func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		target := filepath.Join(dst, rel)
		info, err := d.Info()
		if err != nil {
			return err
		}
		switch {
		case d.Type()&fs.ModeSymlink != 0:
			link, err := os.Readlink(p)
			if err != nil {
				return err
			}
			return os.Symlink(link, target)
		case d.IsDir():
			if err := os.Mkdir(target, info.Mode().Perm()|0o700); err != nil {
				return err
			}
			return nil
		case info.Mode().IsRegular():
			return copyFile(p, target, info)
		default:
			// Sockets, fifos and devices are not checkpointed.
			return nil
		}
	})
}

func copyFile(src, dst string, info fs.FileInfo) error {
	if err := cloneFile(src, dst); err == nil {
		return nil
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
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	mt := info.ModTime()
	return os.Chtimes(dst, time.Now(), mt)
}
