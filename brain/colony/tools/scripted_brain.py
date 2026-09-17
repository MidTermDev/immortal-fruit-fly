#!/usr/bin/env python3
"""A scripted stand-in for the fly's brain, for testing agent.mjs end to end.

It serves the agent protocol of COLONY.md (WebSocket at ws://127.0.0.1:<port>/agent): it receives the senses
JSON at 10 Hz and answers a motor JSON with a hard-coded policy:

  * a hostile mob closing fast in front -> jump, turn away, sprint (the giant-fiber reflex)
  * food in range -> turn toward the strongest scent (points with the arena's distance decay), walk, eat when close
  * otherwise wander (slow turn, half speed)
  * torch once after a meal, say "I smell something…" / "a shadow!" / "yum" as the arena's speech strip does

    /home/ubuntu/flybrain/.venv/bin/python tools/scripted_brain.py --port 9901
    FLY_ID=1 BRAIN_WS=ws://127.0.0.1:9901/agent node agent.mjs

Every notable sense (food appearing, a mob and its closing speed, a pickup, a meal, a hit, a death and the respawn) is logged,
and a WARNING for any message that is not a senses frame (server.py would adopt it as one).
"""
import argparse
import asyncio
import json
import math
import sys
import time

from aiohttp import web

TURN_GAIN = 3.0
TURN_MAX = 3.0


def clamp(x, lo, hi):
    return max(lo, min(hi, x))


class Policy:
    def __init__(self, name):
        self.name = name
        self.t0 = time.time()
        self.seen_food = False
        self.seen_mob = False
        self.torch_pending = False
        self.torch_until = 0.0
        self.said = None
        self.n = 0
        self.last_status = 0.0
        self.last_mob_log = 0.0

    def log(self, *a):
        print(f"[brain {self.name} {time.strftime('%H:%M:%S')}]", *a, flush=True)

    def motor(self, s):
        self.n += 1
        now = time.time()
        m = {"turn": 0.0, "forward": 0.5, "sprint": False, "back": False, "jump": False, "eat": False, "torch": False, "say": None}
        say = None

        if s.get("ate"):
            self.log(f"ATE {s['ate']} points (hunger {s.get('hunger')}, holding {s.get('holdingFood')})")
            self.torch_pending = True
            say = "yum"
        if s.get("picked"):
            self.log(f"PICKED UP {s['picked']} points (holding {s.get('holdingFood')})")
            say = say or "yum"
        if s.get("hit"):
            self.log(f"HIT: health {s.get('health')} (damage {s.get('damage')})")
        if s.get("died"):
            self.log(f"DIED (the killing blow's damage {s.get('damage')}, health now {s.get('health')})")
        if s.get("respawned"):
            self.log(f"RESPAWNED at {s.get('pos')}")

        mobs = s.get("mobs") or []
        food = s.get("food") or []
        if mobs and not self.seen_mob:
            self.seen_mob = True
            say = say or "a shadow!"
        if not mobs:
            self.seen_mob = False
        if mobs and now - self.last_mob_log > 1.0:
            self.last_mob_log = now
            m0 = mobs[0]
            self.log(f"MOB {m0['kind']} dist={m0['dist']} closing={m0['closing']} bearing={m0.get('bearing')} n={len(mobs)}")

        threat = [x for x in mobs if x.get("closing", 0) > 1.0 and x["dist"] < 12]
        if threat:
            x = min(threat, key=lambda k: k["dist"])
            # flee: jump (giant fiber), turn away from it, sprint
            away = x.get("bearing", 0.0)
            m["turn"] = clamp(-math.copysign(TURN_MAX, away) if away else TURN_MAX, -TURN_MAX, TURN_MAX)
            m["forward"] = 1.0
            m["sprint"] = True
            m["jump"] = True
            self.log(f"FLEE {x['kind']} closing={x['closing']} dist={x['dist']} -> jump")
        elif food:
            # the strongest scent: points with the arena's decay over distance
            best = max(food, key=lambda f: f["points"] / (1.0 + 0.15 * f["dist"]))
            if not self.seen_food:
                self.seen_food = True
                say = say or "I smell something…"
                self.log(f"FOOD seen: {best['kind']} x{best.get('count', 1)} dist={best['dist']} bearing={best.get('bearing')}")
            b = best.get("bearing", 0.0)
            m["turn"] = clamp(TURN_GAIN * b, -TURN_MAX, TURN_MAX)
            m["forward"] = 1.0 if abs(b) < 0.8 else 0.3
            m["eat"] = best["dist"] < 4.0 or s.get("holdingFood", 0) > 0
        else:
            self.seen_food = False
            m["turn"] = 0.6 * math.sin((now - self.t0) / 4.0)
            m["forward"] = 0.5
            m["eat"] = s.get("holdingFood", 0) > 0

        # after a meal: stand still for a second and ask the body to mark the spot with a torch
        if self.torch_pending and not s.get("eating") and not threat:
            if self.torch_until == 0.0:
                self.torch_until = now + 1.2
                self.log("TORCH: standing still to mark the meal")
            if now < self.torch_until:
                m["torch"] = True
                m["forward"] = 0.0
                m["turn"] = 0.0
                m["eat"] = False
            else:
                self.torch_pending = False
                self.torch_until = 0.0
        m["say"] = say
        if say:
            self.log(f'SAY "{say}"')

        if now - self.last_status >= 5.0:
            self.last_status = now
            self.log(f"tick {self.n}: pos={s.get('pos')} hp={s.get('health')} hunger={s.get('hunger')} light={s.get('light')} night={s.get('night')} food={len(food)} mobs={len(mobs)} flies={s.get('flies')} holding={s.get('holdingFood')} eating={s.get('eating')}")
        return m


async def agent_ws(request):
    ws = web.WebSocketResponse(heartbeat=10)
    await ws.prepare(request)
    pol = Policy(request.app["name"])
    pol.log(f"agent connected from {request.remote}")
    async for msg in ws:
        if msg.type != web.WSMsgType.TEXT:
            continue
        try:
            s = json.loads(msg.data)
        except json.JSONDecodeError:
            continue
        if not isinstance(s, dict):
            continue
        if not isinstance(s.get("pos"), list):
            # server.py adopts every object on this socket as senses (holdingFood defaults to 0: a phantom meal), so a
            # frame that is not senses is a bug in the agent; it is processed exactly as server.py would, and flagged
            pol.log(f"WARNING: not a senses frame (no pos), the agent must send only senses: {json.dumps(s)[:200]}")
        m = pol.motor(s)
        await ws.send_str(json.dumps(m))
    pol.log("agent disconnected")
    return ws


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=9901)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--name", default="scripted")
    a = ap.parse_args(argv)
    app = web.Application()
    app["name"] = a.name
    app.router.add_get("/agent", agent_ws)
    print(f"scripted brain listening on ws://{a.host}:{a.port}/agent", flush=True)
    web.run_app(app, host=a.host, port=a.port, print=None, handle_signals=True, shutdown_timeout=1.0)
    return 0


if __name__ == "__main__":
    sys.exit(main())
