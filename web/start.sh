#!/bin/sh
# Starts ani-web (lives in web/ of the ani-cli repo) and restarts the server after an in-app self-update.
cd "$(dirname "$0")" || exit 1

command -v node >/dev/null || { echo "node is required (18+)"; exit 1; }
command -v ffmpeg >/dev/null || echo "warning: ffmpeg not found, downloads won't work"

[ -f ../ani-cli ] || { echo "ani-cli script not found in .."; exit 1; }

export ANI_WEB_SUPERVISED=1
while :; do
    node server.js
    [ $? -eq 75 ] || break
    echo "restarting after update..."
done
