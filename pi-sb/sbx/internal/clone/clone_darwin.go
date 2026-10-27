package clone

import "golang.org/x/sys/unix"

// cloneNative clones a file or a whole directory tree in one syscall.
func cloneNative(src, dst string) error {
	return unix.Clonefile(src, dst, unix.CLONE_NOFOLLOW|unix.CLONE_NOOWNERCOPY)
}

func cloneFile(src, dst string) error { return cloneNative(src, dst) }
