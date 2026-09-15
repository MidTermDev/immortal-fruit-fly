#!/usr/bin/env bash
# Starts (or restarts) the whole-brain fly server and its public tunnel.
cd "$(dirname "$0")"
export NUMBA_NUM_THREADS=${NUMBA_NUM_THREADS:-16}
[ -f server.pid ] && kill "$(cat server.pid)" 2>/dev/null
[ -f tunnel.pid ] && kill "$(cat tunnel.pid)" 2>/dev/null
sleep 1
setsid nohup ~/.local/bin/cloudflared tunnel --url http://localhost:8123 --no-autoupdate > tunnel.log 2>&1 &
echo $! > tunnel.pid
for i in $(seq 1 60); do URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' tunnel.log | head -1); [ -n "$URL" ] && break; sleep 1; done
echo "public url: $URL"; echo "$URL" > public_url.txt
PUBLIC_URL="$URL" setsid nohup ../.venv/bin/python server.py >> server.log 2>&1 &
echo $! > server.pid
sleep 15; tail -4 server.log; echo; curl -s localhost:8123/health; echo
