#!/usr/bin/env bash
# Starts (or restarts) the DOOM body service (doom_host.py: one doom.py session at a time for every fly assigned to DOOM).
# Pidfile doom_host.pid; the service logs to doom_host.log itself, stdout/stderr (tracebacks) go to doom_host.out.
# A running session gets DOOM_STOP_GRACE (default 120 s) to finish before the old service is stopped.
#   DOOM_SESSION_MIN=5 DOOM_THREADS=12 ./run_doom_host.sh
cd "$(dirname "$0")"
export PATH="$HOME/.foundry/bin:$PATH"        # doom.py needs cast (the on-chain compass core)
export DOOM_SESSION_MIN=${DOOM_SESSION_MIN:-5}
export DOOM_THREADS=${DOOM_THREADS:-8}
export DOOM_STOP_GRACE=${DOOM_STOP_GRACE:-120}
unset DOOM_DRY
if [ -f doom_host.pid ]; then
  PID=$(cat doom_host.pid)
  if kill -0 "$PID" 2>/dev/null; then
    echo "stopping doom_host pid $PID"; kill "$PID"
    for i in $(seq 1 $((${DOOM_STOP_GRACE%.*} + 90))); do kill -0 "$PID" 2>/dev/null || break; sleep 1; done
    kill -0 "$PID" 2>/dev/null && { echo "still running after grace; sending a second SIGTERM"; kill "$PID"; sleep 40; }
  fi
  rm -f doom_host.pid
fi
setsid nohup ../.venv/bin/python doom_host.py >> doom_host.out 2>&1 &
echo $! > doom_host.pid
sleep 4; echo "doom_host pid $(cat doom_host.pid)"; tail -5 doom_host.log
