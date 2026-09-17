#!/usr/bin/env bash
# The Colony's Paper server.
#
#   tools/run_server.sh start    start detached (pidfile server/server.pid), wait for "Done", apply the world setup
#   tools/run_server.sh run      start in the foreground (a supervisor owning the process; run `setup` itself after "Done")
#   tools/run_server.sh setup    apply gamerules / spawn / the lit spawn glade over RCON (idempotent; needs a running server)
#   tools/run_server.sh stop     graceful `stop` over RCON, SIGTERM after 30 s, SIGKILL after 60 s
#   tools/run_server.sh status   is it running? (exit 0 yes / 1 no)
#
# cwd is server/; the JVM runs `java -Xms1G -Xmx3G -jar paper.jar nogui`; Paper writes server/logs/latest.log and
# the JVM's own stdout/stderr goes to server/logs/console.log. The RCON password lives in server/rcon.txt
# (generated here on first start, mode 600, gitignored) and is copied into server.properties at every start.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COLONY="$(dirname "$HERE")"
SERVER="$COLONY/server"
PIDFILE="$SERVER/server.pid"
RCON_FILE="$SERVER/rcon.txt"
JAVA="${JAVA:-$HOME/.sdkman/candidates/java/current/bin/java}"
[ -x "$JAVA" ] || JAVA="$(command -v java)"
PY="${PY:-$COLONY/../../.venv/bin/python}"
[ -x "$PY" ] || PY="$(command -v python3)"
XMS="${XMS:-1G}"
XMX="${XMX:-3G}"
DONE_TIMEOUT="${DONE_TIMEOUT:-180}"

pid_alive() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

prepare() {
  cd "$SERVER"
  [ -f paper.jar ] || { echo "server/paper.jar is missing: run tools/fetch_paper.sh" >&2; exit 1; }
  mkdir -p logs
  if [ ! -s "$RCON_FILE" ]; then
    (umask 077; head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24 > "$RCON_FILE"; echo >> "$RCON_FILE")
    echo "generated $RCON_FILE"
  fi
  local pw; pw="$(head -n1 "$RCON_FILE" | tr -d '[:space:]')"
  [ -f server.properties ] || cp server.properties.in server.properties
  # always refresh the password (Paper re-saves the file; the template is the source of everything else)
  if grep -q '^rcon\.password=' server.properties; then
    sed -i "s|^rcon\.password=.*|rcon.password=$pw|" server.properties
  else
    echo "rcon.password=$pw" >> server.properties
  fi
  grep -q '^enable-rcon=true' server.properties || sed -i 's|^enable-rcon=.*|enable-rcon=true|' server.properties
}

start() {
  if pid_alive; then echo "already running (pid $(cat "$PIDFILE"))"; return 0; fi
  prepare
  cd "$SERVER"
  local started; started="$(date +%s)"
  nohup "$JAVA" -Xms"$XMS" -Xmx"$XMX" -XX:+UseG1GC -jar paper.jar nogui >> logs/console.log 2>&1 &
  echo $! > "$PIDFILE"
  echo "started paper.jar (pid $(cat "$PIDFILE")), waiting for Done…"
  local i=0
  while [ "$i" -lt "$DONE_TIMEOUT" ]; do
    sleep 1; i=$((i+1))
    pid_alive || { echo "server exited early; see server/logs/console.log" >&2; tail -n 20 logs/console.log >&2; rm -f "$PIDFILE"; return 1; }
    if [ -f logs/latest.log ] && [ "$(stat -c %Y logs/latest.log)" -ge "$started" ] && grep -q 'Done (' logs/latest.log; then
      grep 'Done (' logs/latest.log | tail -n1
      setup
      return 0
    fi
  done
  echo "no 'Done' after ${DONE_TIMEOUT}s; the server is still starting (pid $(cat "$PIDFILE"))" >&2
  return 1
}

run() {
  if pid_alive; then echo "already running (pid $(cat "$PIDFILE"))" >&2; exit 1; fi
  prepare
  cd "$SERVER"
  echo $$ > "$PIDFILE"
  trap 'rm -f "$PIDFILE"' EXIT
  exec "$JAVA" -Xms"$XMS" -Xmx"$XMX" -XX:+UseG1GC -jar paper.jar nogui
}

setup() {
  # Everything here is idempotent: the gamerules of COLONY.md, a fixed spawn, a small world border,
  # no weather, and a lit spawn glade (a ring of torches around 0,64,0 (the superflat surface is y=63)) where the flies arrive.
  "$PY" "$HERE/rcon.py" --wait 60 - <<'CMDS'
gamerule keepInventory true
gamerule doDaylightCycle true
gamerule doMobSpawning true
gamerule doImmediateRespawn true
gamerule doWeatherCycle false
gamerule mobGriefing false
gamerule announceAdvancements false
gamerule spawnRadius 2
weather clear
setworldspawn 0 64 0
worldborder center 0 0
worldborder set 256
forceload add -16 -16 16 16
setblock 5 64 5 minecraft:torch
setblock -5 64 5 minecraft:torch
setblock 5 64 -5 minecraft:torch
setblock -5 64 -5 minecraft:torch
setblock 0 64 8 minecraft:torch
setblock 0 64 -8 minecraft:torch
setblock 8 64 0 minecraft:torch
setblock -8 64 0 minecraft:torch
CMDS
  # trees, flowers, ponds, berry bushes, hay and the campfire ring: once (a marker block remembers)
  "$(dirname "$0")/../../../.venv/bin/python" "$(dirname "$0")/build_glade.py" || true
}

stop() {
  if ! pid_alive; then echo "not running"; rm -f "$PIDFILE"; return 0; fi
  local pid; pid="$(cat "$PIDFILE")"
  "$PY" "$HERE/rcon.py" stop >/dev/null 2>&1 || kill -TERM "$pid" 2>/dev/null || true
  local i=0
  while kill -0 "$pid" 2>/dev/null; do
    sleep 1; i=$((i+1))
    [ "$i" -eq 30 ] && kill -TERM "$pid" 2>/dev/null || true
    [ "$i" -ge 60 ] && { kill -KILL "$pid" 2>/dev/null || true; break; }
  done
  rm -f "$PIDFILE"
  echo "stopped (pid $pid)"
}

status() {
  if pid_alive; then echo "running (pid $(cat "$PIDFILE"))"; return 0; fi
  echo "not running"; return 1
}

case "${1:-start}" in
  start) start ;;
  run) run ;;
  setup) setup ;;
  stop) stop ;;
  status) status ;;
  *) echo "usage: $0 [start|run|setup|stop|status]" >&2; exit 2 ;;
esac
