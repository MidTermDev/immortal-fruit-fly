#!/usr/bin/env bash
# Starts (or restarts) the registry index (index.py) on :8127. Pidfile index.pid, log index.log.
cd "$(dirname "$0")"
[ -f index.pid ] && kill "$(cat index.pid)" 2>/dev/null; sleep 1
setsid nohup ../.venv/bin/python index.py >> index.log 2>&1 &
echo $! > index.pid; sleep 3; tail -2 index.log
