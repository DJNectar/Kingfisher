#!/bin/bash
#
# Kingfisher.app — what macOS runs when the icon is double-clicked.
#
# The app is a web app that must be SERVED rather than opened from disk: a
# browser gives a file:// page an opaque origin, which disables both ES module
# loading and the file access Kingfisher depends on. So this starts a server on
# the loopback interface, opens a browser at it, and stays in the foreground so
# that quitting the app takes the server down with it.
#
# Everything here assumes nobody is watching a terminal, because in a .app
# nobody is. Anything that goes wrong has to say so in a window.

set -u

APP_ROOT="$(cd "$(dirname "$0")/../Resources/app" && pwd)"
LOG="${TMPDIR:-/tmp}/kingfisher-server.log"

say() {
  # A dialog, because there is no console to print to. Kept to one button and
  # plain language: whoever sees this is trying to look at an audio file, not
  # debug a launcher.
  /usr/bin/osascript -e "display dialog \"$1\" with title \"Kingfisher\" buttons {\"OK\"} default button 1 with icon caution" >/dev/null 2>&1
}

# ---------------------------------------------------------------- python

# macOS ships python3, but on a machine that has never had the developer tools
# installed it is a stub that prompts instead of running. Calling it and
# checking the result is the only way to tell the two apart.
PYTHON="$(command -v python3 || true)"
if [ -z "$PYTHON" ] || ! "$PYTHON" -c "import sys" >/dev/null 2>&1; then
  say "Kingfisher needs Python, which Apple includes with macOS but does not install until something asks for it.\n\nOpening Terminal and running:\n\n    python3 --version\n\nwill prompt macOS to install it. Accept, wait for it to finish, then open Kingfisher again.\n\nThis is a one-time step."
  exit 1
fi

# ---------------------------------------------------------------- port

# Start above the range a development server usually takes, and step past
# anything already listening — including a previous copy of this app.
PORT=8181
while [ "$PORT" -lt 8250 ]; do
  if ! /usr/bin/nc -z 127.0.0.1 "$PORT" >/dev/null 2>&1; then break; fi
  PORT=$((PORT + 1))
done
if [ "$PORT" -ge 8250 ]; then
  say "Kingfisher could not find a free port to run on. Restarting your Mac will clear whatever is holding them."
  exit 1
fi

URL="http://localhost:$PORT"

# ---------------------------------------------------------------- serve

cd "$APP_ROOT" || { say "Kingfisher could not find its own files. The app may not have copied fully — try dragging it out of the disk image or download again."; exit 1; }

# Bound to the loopback interface on purpose: this listens to this machine and
# publishes nothing to the network.
"$PYTHON" -m http.server "$PORT" --bind 127.0.0.1 >"$LOG" 2>&1 &
SERVER=$!

# Take the server down whenever this script ends, however it ends — quitting
# the app, logging out, a crash. A server outliving its app is how a port ends
# up held by something with no window.
trap 'kill "$SERVER" 2>/dev/null' EXIT INT TERM

# Wait for it to actually accept connections before pointing a browser at it,
# rather than sleeping a fixed second and hoping.
for _ in $(seq 1 50); do
  if /usr/bin/nc -z 127.0.0.1 "$PORT" >/dev/null 2>&1; then break; fi
  sleep 0.1
done

if ! /usr/bin/nc -z 127.0.0.1 "$PORT" >/dev/null 2>&1; then
  say "Kingfisher could not start its local server.\n\nDetails were written to:\n$LOG"
  exit 1
fi

# ---------------------------------------------------------------- browser

# Chrome by preference: it can save straight back to the library file, where
# Safari can only download a copy. Fall back to whatever is set as default.
if ! /usr/bin/open -a "Google Chrome" "$URL" >/dev/null 2>&1; then
  /usr/bin/open "$URL" >/dev/null 2>&1
fi

# Hold the foreground. This is what keeps Kingfisher in the Dock and makes
# Quit mean something: the moment this returns, the trap above stops the
# server.
wait "$SERVER"
