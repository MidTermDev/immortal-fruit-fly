#!/usr/bin/env bash
# Starts (or restarts) the life keeper (lifekeeper.py). Pidfile lifekeeper.pid, log lifekeeper.log.
cd "$(dirname "$0")"
[ -f lifekeeper.pid ] && kill "$(cat lifekeeper.pid)" 2>/dev/null; sleep 1
setsid nohup ../.venv/bin/python lifekeeper.py >> lifekeeper.log 2>&1 &
echo $! > lifekeeper.pid; sleep 4; tail -2 lifekeeper.log
