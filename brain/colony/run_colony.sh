#!/usr/bin/env bash
# Starts (or restarts) the Colony supervisor (colony.py: the Paper server, one whole brain + mineflayer body + viewer per fly whose body is
# the Colony, the food drops, the proxy) on COLONY_PORT (8125) and announces PUBLIC_URL as the Colony body on the registry.
# Like run_host.sh but WITHOUT a tunnel: DNS for mc.immortalfly.app points at this box and nginx terminates TLS and proxies everything
# (HTTP and WebSocket) to 127.0.0.1:8125. Pidfile colony.pid, log colony.log (both in this directory).
cd "$(dirname "$0")"
export COLONY_PORT=${COLONY_PORT:-8125}
export COLONY_THREADS=${COLONY_THREADS:-10}   # shared with the arena, the brain host and DOOM on this box
export PUBLIC_URL=${PUBLIC_URL:-https://mc.immortalfly.app}
if [ -f colony.pid ]; then
  PID=$(cat colony.pid)
  if kill "$PID" 2>/dev/null; then for i in $(seq 1 120); do kill -0 "$PID" 2>/dev/null || break; sleep 1; done; fi
fi
sleep 1
ANNOUNCE=1 setsid nohup ../../.venv/bin/python colony.py >> colony.log 2>&1 &
echo $! > colony.pid
echo "colony pid $(cat colony.pid) on :$COLONY_PORT, public url $PUBLIC_URL"
sleep 5; tail -4 colony.log; echo; curl -s localhost:$COLONY_PORT/colony/state; echo
