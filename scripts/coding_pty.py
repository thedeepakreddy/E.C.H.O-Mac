"""Small macOS PTY bridge. argv is data; never passed through a shell."""
import errno
import json
import os
import pty
import select
import signal
import sys
import time

command = json.loads(sys.argv[1])
child, master = pty.fork()
if child == 0:
    os.environ.setdefault("TERM", "xterm-256color")
    os.execvpe(command[0], command, os.environ)

def terminate(signum, _frame):
    # The PTY child owns a new session; signal its group as well as this bridge.
    try:
        os.killpg(child, signal.SIGTERM)
        time.sleep(0.1)
        os.killpg(child, signal.SIGKILL)
    except ProcessLookupError:
        pass
    sys.exit(128 + signum)

for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
    signal.signal(sig, terminate)
stdin_open = True
try:
    while True:
        sources = [master] + ([0] if stdin_open else [])
        ready, _, _ = select.select(sources, [], [], 0.1)
        if 0 in ready:
            data = os.read(0, 65536)
            if data:
                os.write(master, data)
            else:
                stdin_open = False
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                break
            if not data:
                break
            os.write(1, data)
finally:
    os.close(master)
_, status = os.waitpid(child, 0)
code = os.waitstatus_to_exitcode(status)
sys.exit(code if code >= 0 else 128 - code)
