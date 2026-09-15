#!/bin/bash
# Double-click this file in Finder to start Kingfisher.
#
# Why a local server is needed at all: browsers treat a page opened straight
# from disk (file://) as having no origin, which disables the file-picking and
# module loading Kingfisher depends on. Serving the same folder over
# http://localhost restores both. The server below listens only on this machine
# and publishes nothing to the internet.

cd "$(dirname "$0")" || exit 1

PORT=8181
while lsof -i ":$PORT" >/dev/null 2>&1; do
  PORT=$((PORT + 1))
done

echo "Kingfisher is running at http://localhost:$PORT"
echo "Leave this window open while you use it. Press Control-C here to stop."

# Open the browser once the server is actually listening.
( sleep 1; open "http://localhost:$PORT" ) &

exec python3 -m http.server "$PORT" --bind 127.0.0.1
