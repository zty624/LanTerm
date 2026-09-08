"""Acquire the slave PTY as controlling terminal, then replace this process with tmux.

The parent starts a new POSIX session. Running ioctl here avoids preexec_fn/fork
callbacks inside the multithreaded async Web server, and lets the kernel deliver
SIGWINCH to tmux when the browser changes the PTY dimensions.
"""

import fcntl
import os
import sys
import termios

if __name__ == "__main__":
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)
    os.execvp(sys.argv[1], sys.argv[1:])
