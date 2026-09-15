#!/usr/bin/env bash
# Starts (or restarts) the brain host (flyhost.py: one whole brain per pebble-bodied fly) and its public tunnel,
# and announces the tunnel url as the "Brain host" body on the registry. Like run.sh, on HOST_PORT (8124).
cd "$(dirname "$0")"
export HOST_PORT=${HOST_PORT:-8124}
for f in host.pid host_tunnel.pid; do
  [ -f "$f" ] && PID=$(cat "$f") && kill "$PID" 2>/dev/null && for i in $(seq 1 60); do kill -0 "$PID" 2>/dev/null || break; sleep 1; done
done
sleep 1
setsid nohup ~/.local/bin/cloudflared tunnel --url http://localhost:$HOST_PORT --no-autoupdate > host_tunnel.log 2>&1 &
echo $! > host_tunnel.pid
for i in $(seq 1 60); do URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' host_tunnel.log | head -1); [ -n "$URL" ] && break; sleep 1; done
echo "public url: $URL"; echo "$URL" > host_url.txt
PUBLIC_URL="$URL" ANNOUNCE=1 setsid nohup ../.venv/bin/python flyhost.py >> host.log 2>&1 &
echo $! > host.pid
sleep 5; tail -4 host.log; echo; curl -s localhost:$HOST_PORT/; echo
