package sandbox

import (
	_ "embed"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// base.sbpl is adapted from OpenAI Codex's Seatbelt policy (Apache-2.0),
// itself derived from Chrome's: deny by default, then allow the process,
// sysctl, IPC and pty basics that ordinary developer tools need.
//
//go:embed base.sbpl
var basePolicy string

//go:embed network.sbpl
var networkPolicy string

// Profile builds the Seatbelt profile for the box.
//
// Reads: the whole system is readable except user data (/Users, /Volumes and
// the shared temp dirs); the cwd, the box and configured paths are re-allowed.
// Writes: only the cwd, the box home and tmp, and configured write paths.
func Profile(c *Config, b *Box, sbxBin string) string {
	var p strings.Builder
	w := func(format string, args ...any) { fmt.Fprintf(&p, format+"\n", args...) }
	q := func(s string) string { return fmt.Sprintf("%q", s) }

	p.WriteString(basePolicy)
	if c.Network == "local" {
		w(`(allow network-outbound (remote ip "localhost:*"))`)
		w(`(allow network-inbound (local ip "localhost:*"))`)
		w(`(allow network-bind (local ip "localhost:*"))`)
	} else {
		p.WriteString(networkPolicy)
	}
	// Unix sockets reach host daemons (docker, ssh-agent, pi itself); only DNS
	// and syslog are allowed.
	w(`(deny network-outbound (remote unix-socket))`)
	w(`(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))`)
	w(`(allow network-outbound (literal "/private/var/run/syslog"))`)

	readable := append([]string{c.Cwd, b.Home, b.Tmp}, c.Read...)
	readable = append(readable, c.Write...)
	writable := append([]string{c.Cwd, b.Home, b.Tmp}, c.Write...)

	w("; reads")
	w("(allow file-read*)")
	w(`(deny file-read* (subpath "/Users") (subpath "/Volumes") (subpath "/private/tmp") (subpath "/private/var/folders"))`)
	for _, r := range readable {
		r = real(r)
		w("(allow file-read-metadata (path-ancestors %s))", q(r))
		w("(allow file-read* (subpath %s))", q(r))
	}
	w("(allow file-read* (literal %s))", q(real(sbxBin)))
	if t := darwinTempDir(); t != "" {
		// xcrun (behind /usr/bin/git, python3, clang) keeps a cache here.
		w("(allow file-read* (literal %s))", q(t))
		w(`(allow file-read* file-write* (regex #"^/private/var/folders/[^/]+/[^/]+/T/xcrun_db"))`)
	}

	w("; writes")
	for _, r := range writable {
		w("(allow file-write* (subpath %s))", q(real(r)))
	}
	w(`(allow file-write-data (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper"))`)
	w(`(allow file-read* file-write-data (subpath "/dev/fd"))`)

	w("; protections, after the allows so they win")
	w("(deny file-write-unlink (require-all (literal %s) (vnode-type DIRECTORY)))", q(c.Cwd))
	w("(deny file-read* file-write* (subpath %s))", q(b.Store))
	for _, rel := range c.Protect {
		target := filepath.Join(c.Cwd, rel)
		w("(deny file-write* (literal %s) (subpath %s))", q(target), q(target))
	}
	for _, d := range c.Deny {
		w("(deny file-read* file-write* (literal %s) (subpath %s))", q(d), q(d))
	}
	// These fcntls modify files through read-only descriptors.
	w("(deny system-fcntl (fcntl-command 80 110))")
	w(`(deny mach-lookup (xpc-service-name-prefix ""))`)
	return p.String()
}

// Command returns the command that starts argv inside the sandbox.
func Command(profile string, argv []string) *exec.Cmd {
	return exec.Command("/usr/bin/sandbox-exec", append([]string{"-p", profile}, argv...)...)
}

func real(p string) string {
	if r, err := filepath.EvalSymlinks(p); err == nil {
		return r
	}
	return p
}

func darwinTempDir() string {
	out, err := exec.Command("/usr/bin/getconf", "DARWIN_USER_TEMP_DIR").Output()
	if err != nil {
		return ""
	}
	t := strings.TrimSuffix(strings.TrimSpace(string(out)), "/")
	if strings.HasPrefix(t, "/var/") {
		t = "/private" + t
	}
	if _, err := os.Stat(t); err != nil {
		return ""
	}
	return t
}
