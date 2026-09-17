#!/usr/bin/env node
// agent.mjs: the Minecraft body of one fly (COLONY.md section 4).
//
// A mineflayer bot named fly<id> joins the Colony's Paper server, sends what it senses to the fly's brain
// over a local WebSocket at 10 Hz and applies the motor commands it gets back. It does no thinking.
//
//   FLY_ID=12 BRAIN_WS=ws://127.0.0.1:9012/agent node agent.mjs
//   node agent.mjs --id 12 --name fly12 --brain ws://127.0.0.1:9012/agent --host 127.0.0.1 --port 25565
//
// Senses (Node -> Python, every 100 ms), the fields of COLONY.md plus a few honest extras:
//   {t, pos:[x,y,z], yaw, health, onGround, light, night,
//    food:[{dx,dz,dist,points,kind,bearing,count}], mobs:[{dx,dz,dist,kind,closing,bearing}], flies:[{id,dist,name}],
//    eating, holdingFood, hit, damage, died, respawned, hunger, picked, ate, torches, time}
//   dx/dz are world-frame offsets (target - bot); `bearing` is the angle from the bot's heading to the target in
//   radians, positive = to the bot's LEFT (the same sense as `turn`); yaw is mineflayer's (0 = north/-z, +pi/2 = west,
//   increasing = turning left). `picked`/`ate` are the food points picked up / swallowed since the last tick.
//   `hit`/`damage` are the health lost since the last tick (every health packet is counted, so the killing blow is
//   never lost); `died`/`respawned` are true on the one tick after a Minecraft death / respawn.
// Motor (Python -> Node): {turn, forward, sprint, back, jump, eat, torch, say}; see applyMotor() below.
//
// Every message on the brain socket is a senses frame (COLONY.md section 4): the brain adopts any object it receives
// as senses, so nothing else (no hello, no status) is ever sent on it.
// The bot reconnects to the server and to the brain with backoff and stops moving when the brain is silent for 1 s.
// VIEWER_PORT=<port> (VIEWER_PREFIX=/fly/<id>/view) also serves a prismarine-viewer of what this fly sees.

import mineflayer from 'mineflayer'
import { Vec3 } from 'vec3'

// ---------------------------------------------------------------- configuration
function arg (flag, env, dflt) {
  const i = process.argv.indexOf(flag)
  if (i !== -1 && process.argv[i + 1] !== undefined) return process.argv[i + 1]
  return process.env[env] !== undefined && process.env[env] !== '' ? process.env[env] : dflt
}
const FLY_ID = parseInt(arg('--id', 'FLY_ID', '0'), 10)
const NAME = String(arg('--name', 'NAME', `fly${FLY_ID}`)).slice(0, 16)
const BRAIN_WS = arg('--brain', 'BRAIN_WS', `ws://127.0.0.1:${9000 + FLY_ID}/agent`)
const HOST = arg('--host', 'SERVER_HOST', '127.0.0.1')
const PORT = parseInt(arg('--port', 'SERVER_PORT', '25565'), 10)
const MC_VERSION = arg('--version', 'MC_VERSION', '1.21.4')
const TICK_MS = 100 // 10 Hz
const MOTOR_TIMEOUT_MS = 1000 // no motor command for this long -> stand still
const VERBOSE = process.env.AGENT_VERBOSE === '1'
// optional in-process prismarine-viewer of this fly's world (the supervisor proxies it under /fly/<id>/view/)
const VIEWER_PORT = parseInt(arg('--viewer', 'VIEWER_PORT', '0'), 10)
const VIEWER_PREFIX = arg('--viewer-prefix', 'VIEWER_PREFIX', '')
const VIEWER_FIRST_PERSON = process.env.VIEWER_FIRST_PERSON !== '0'

const FOOD_POINTS = { bread: 5, apple: 4, cookie: 2, sweet_berries: 2 }
const FOOD_RANGE = 32
const MOB_RANGE = 24
const MOB_HALF_FOV = Math.PI / 3 // the front 120 degrees
const FLY_RANGE = 6
const HOSTILE = new Set([
  'zombie', 'zombie_villager', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'wither_skeleton', 'spider',
  'cave_spider', 'creeper', 'enderman', 'witch', 'phantom', 'slime', 'pillager', 'vindicator', 'evoker', 'ravager',
  'vex', 'silverfish', 'endermite', 'zoglin', 'hoglin', 'piglin_brute', 'blaze', 'ghast', 'magma_cube', 'warden',
  'breeze', 'creaking', 'giant', 'illusioner'
])
const TORCH_EVERY_MS = 30_000
const SAY_EVERY_MS = 5_000 // one chat line per 5 s; the brain's lines come in bursts, so they queue (below)
const SAY_QUEUE_MAX = 4 // the newest lines are kept when the queue is full (as the brain's own pending list does)
const SAY_MAX_AGE_MS = SAY_QUEUE_MAX * SAY_EVERY_MS // a line older than this is stale and is dropped unsaid
const TURN_MAX = 3.0 // rad/s

// ---------------------------------------------------------------- logging
function stamp () { return new Date().toISOString().slice(11, 19) }
function log (...a) { console.log(`[${NAME} ${stamp()}]`, ...a) }
function warn (...a) { console.error(`[${NAME} ${stamp()}]`, ...a) }

// ---------------------------------------------------------------- state
let bot = null
let spawned = false
let stopping = false
let serverBackoff = 2000
let ws = null
let wsBackoff = 1000
let motor = null // last motor command
let motorAt = 0 // when it arrived (ms)
let yaw = 0 // our integrated heading (mineflayer radians)
// health: mineflayer emits 'spawn' before it has stored the first health packet (bot.health is undefined then), so a
// persisted health below 20 must not read as a hit on (re)join: nothing is compared until the first 'health' event
// (healthKnown), and every health packet after that is counted into damageAcc as it arrives, so a drop that is
// undone within one tick (the killing blow, then the respawn's health 20) is still reported.
let healthKnown = false
let lastHealth = 20 // the last health the server reported (what `health` says while bot.health is still unknown)
let damageAcc = 0 // health lost since the last tick
let hitFlag = false // the server reported damage to the bot since the last tick (damage_event)
let hitHeld = false // a damage event without its health packet yet was held for one tick (see senses)
let diedFlag = false // the bot died since the last tick
let respawnedFlag = false // the bot respawned (is back at world spawn) since the last tick
let deaths = 0
let lastHolding = 0
let eating = false
let ateThisTick = 0
let lastTorchAt = 0
let lastSayAt = 0
const sayQueue = [] // [{text, at}], flushed one line per SAY_EVERY_MS by the tick
let torchInFlight = false
let torchWantedUntil = 0
let fullWarned = false
let walkAcc = 0 // PWM accumulator for forward in (0,1)
let jumpTicks = 0
let lastJumpLog = 0
const mobTrack = new Map() // entity id -> {t, dist, closing}
let statusAt = 0
let tickTimer = null

// ---------------------------------------------------------------- brain WebSocket
function connectBrain () {
  if (stopping) return
  let sock
  try {
    sock = new WebSocket(BRAIN_WS)
  } catch (e) {
    warn('brain ws error', e.message)
    setTimeout(connectBrain, wsBackoff)
    return
  }
  sock.onopen = () => {
    ws = sock
    wsBackoff = 1000
    // nothing is sent here: the brain takes every message on this socket as a senses frame (a greeting with no
    // holdingFood would be a phantom meal), so the first thing it hears is the next tick's real senses
    log('brain connected', BRAIN_WS, `(fly ${FLY_ID}, ${NAME}, mc ${MC_VERSION})`)
  }
  sock.onmessage = (ev) => {
    try {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())
      if (m && typeof m === 'object' && !Array.isArray(m)) {
        motor = m
        motorAt = Date.now()
        // `say` is one-shot from the brain (each line is handed out once), so it is queued here, once per message,
        // never from applyMotor (which re-applies the same motor frame every tick until the next one arrives)
        if (typeof m.say === 'string' && m.say.trim()) enqueueSay(m.say)
      }
    } catch (e) {
      warn('bad motor json', e.message)
    }
  }
  sock.onerror = () => {}
  sock.onclose = (ev) => {
    if (ws === sock) {
      ws = null
      log('brain disconnected', ev.code || '', ev.reason || '')
    }
    motor = null
    if (bot && spawned) bot.clearControlStates()
    if (!stopping) {
      setTimeout(connectBrain, wsBackoff)
      wsBackoff = Math.min(wsBackoff * 2, 15_000)
    }
  }
}

function sendSenses (obj) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)) } catch (e) { warn('ws send', e.message) }
  }
}

// ---------------------------------------------------------------- speech
// The brain's lines come in bursts ("there!" then "yum" 100 ms apart); chat is one line per SAY_EVERY_MS, so the
// lines wait in a bounded queue (a line already waiting is not queued twice; the newest SAY_QUEUE_MAX are kept;
// a line older than SAY_MAX_AGE_MS is stale and is dropped) and the tick says one whenever the last was 5 s ago.
function enqueueSay (line) {
  const text = String(line).trim().slice(0, 100)
  if (!text || sayQueue.some((q) => q.text === text)) return
  sayQueue.push({ text, at: Date.now() })
  while (sayQueue.length > SAY_QUEUE_MAX) sayQueue.shift()
}
function flushSay (now) {
  while (sayQueue.length && now - sayQueue[0].at > SAY_MAX_AGE_MS) { const q = sayQueue.shift(); if (VERBOSE) warn(`say: dropped stale "${q.text}"`) }
  if (!sayQueue.length || now - lastSayAt < SAY_EVERY_MS) return
  const { text } = sayQueue.shift()
  lastSayAt = now
  try { bot.chat(text); log(`says "${text}"${sayQueue.length ? ` (${sayQueue.length} more waiting)` : ''}`) } catch (e) { warn('chat', e.message) }
}

// ---------------------------------------------------------------- helpers
function wrap (a) {
  while (a > Math.PI) a -= 2 * Math.PI
  while (a < -Math.PI) a += 2 * Math.PI
  return a
}
// mineflayer's heading vector is (-sin yaw, 0, -cos yaw); the yaw that points at (dx, dz) is atan2(-dx, -dz)
function bearingTo (dx, dz) { return wrap(Math.atan2(-dx, -dz) - yaw) }
function r2 (x) { return Math.round(x * 100) / 100 }

// vanilla's skyDarken (0 by day .. 11 at midnight), from the time of day in ticks
function skyDarken (timeOfDay) {
  const d = ((timeOfDay / 24000 - 0.25) % 1 + 1) % 1
  const e = 0.5 - Math.cos(d * Math.PI) / 2
  const sunAngle = (d * 2 + e) / 3
  const f = 0.5 + 2 * Math.max(-0.25, Math.min(0.25, Math.cos(sunAngle * Math.PI * 2)))
  return Math.floor((1 - f) * 11)
}

function holdingFood () {
  let pts = 0
  for (const it of bot.inventory.items()) if (FOOD_POINTS[it.name]) pts += FOOD_POINTS[it.name] * it.count
  return pts
}
function torchCount () {
  let n = 0
  for (const it of bot.inventory.items()) if (it.name === 'torch') n += it.count
  return n
}

// ---------------------------------------------------------------- senses
function senses () {
  const me = bot.entity
  const p = me.position
  const now = Date.now()
  const food = []
  const mobs = []
  const flies = []
  const seen = new Set()
  for (const ent of Object.values(bot.entities)) {
    if (!ent || ent === me || !ent.position) continue
    const dx = ent.position.x - p.x
    const dz = ent.position.z - p.z
    const dist = Math.hypot(dx, dz, ent.position.y - p.y)
    if (ent.name === 'item' && dist <= FOOD_RANGE) {
      let item = null
      try { item = ent.getDroppedItem() } catch (_) {}
      if (item && FOOD_POINTS[item.name]) {
        food.push({ dx: r2(dx), dz: r2(dz), dist: r2(dist), points: FOOD_POINTS[item.name] * item.count, kind: item.name, bearing: r2(bearingTo(dx, dz)), count: item.count })
      }
    } else if (ent.type === 'player' && ent.username && ent.username !== NAME) {
      const m = /^fly(\d+)$/.exec(ent.username)
      if (m && dist <= FLY_RANGE) flies.push({ id: parseInt(m[1], 10), dist: r2(dist), name: ent.username })
    } else if (ent.name && HOSTILE.has(ent.name) && dist <= MOB_RANGE) {
      const bearing = bearingTo(dx, dz)
      // closing speed: blocks/s toward the bot, from the change of distance since the last tick (EMA)
      const prev = mobTrack.get(ent.id)
      let closing = 0
      if (prev && now > prev.t) {
        const inst = (prev.dist - dist) / ((now - prev.t) / 1000)
        closing = prev.closing * 0.5 + inst * 0.5
      }
      mobTrack.set(ent.id, { t: now, dist, closing })
      seen.add(ent.id)
      if (Math.abs(bearing) <= MOB_HALF_FOV) {
        mobs.push({ dx: r2(dx), dz: r2(dz), dist: r2(dist), kind: ent.name, closing: r2(closing), bearing: r2(bearing) })
      }
    }
  }
  for (const id of mobTrack.keys()) if (!seen.has(id)) mobTrack.delete(id)
  food.sort((a, b) => a.dist - b.dist)
  mobs.sort((a, b) => a.dist - b.dist)

  const feet = bot.blockAt(p) || {}
  const timeOfDay = bot.time ? bot.time.timeOfDay : 6000
  const sky = Math.max(0, (feet.skyLight ?? 15) - skyDarken(timeOfDay))
  const light = Math.max(feet.light ?? 0, sky)
  const night = timeOfDay >= 13000 && timeOfDay < 23000

  const holding = holdingFood()
  const picked = Math.max(0, holding - lastHolding) // the inventory delta alone: consume() can resolve before the swallow (a held-item change), so `ate` must not be trusted here
  lastHolding = holding
  // health and damage come from the 'health' events (every packet counted, see onHealth), not from a comparison
  // between ticks: a hit whose health drop is undone within the tick (killed and respawned at 20) still carries its
  // damage, and an unknown health right after (re)joining is never mistaken for a hit
  const health = typeof bot.health === 'number' ? bot.health : lastHealth
  // the server sends the damage event at once and the health packet at the end of the player's tick, so the two can
  // straddle a 100 ms tick here: a damage event with no health drop yet is held for one tick, so that the frame that
  // says hit=true carries the damage (an edge frame with damage 0 followed by the real number is what a brain that
  // reads `damage` on the edge would get otherwise)
  let hit = hitFlag || damageAcc > 0
  if (hitFlag && damageAcc === 0 && !hitHeld && !diedFlag) { hitHeld = true; hit = false }
  else hitHeld = false
  const damage = hit ? r2(damageAcc) : 0
  const died = diedFlag
  const respawned = respawnedFlag
  if (hit) { hitFlag = false; damageAcc = 0 }
  diedFlag = false
  respawnedFlag = false
  const ate = ateThisTick
  ateThisTick = 0

  return {
    t: now / 1000,
    pos: [r2(p.x), r2(p.y), r2(p.z)],
    yaw: r2(wrap(me.yaw)),
    health: r2(health),
    onGround: !!me.onGround,
    light,
    night,
    food,
    mobs,
    flies,
    eating,
    holdingFood: holding,
    hit,
    damage,
    died,
    respawned,
    hunger: bot.food ?? 20,
    picked,
    ate,
    torches: torchCount(),
    time: timeOfDay
  }
}

// ---------------------------------------------------------------- motor
function applyMotor (m, s, dt) {
  const now = Date.now()
  let turn = Number(m.turn) || 0
  turn = Math.max(-TURN_MAX, Math.min(TURN_MAX, turn))
  let forward = Math.max(0, Math.min(1, Number(m.forward) || 0))
  let sprint = !!m.sprint
  const back = !!m.back && !(forward > 0)
  const eat = !!m.eat

  // eat: the tongue reflex. With no food in hand and a morsel within reach, face it and walk onto it
  // (pickup is automatic within ~1 block); the brain does the long-range steering.
  if (eat && s.holdingFood === 0 && s.food.length && s.food[0].dist <= 4) {
    const f = s.food[0]
    turn = Math.max(-TURN_MAX, Math.min(TURN_MAX, f.bearing * 4))
    forward = f.dist > 0.6 ? 1 : 0
    sprint = false
  }

  yaw = wrap(yaw + turn * dt)
  bot.look(yaw, 0, true).catch(() => {})

  let walk = false
  if (forward >= 0.9) {
    walk = true
    walkAcc = 0
  } else if (forward > 0.05) {
    walkAcc += forward // PWM: walk on the ticks the accumulator crosses 1
    if (walkAcc >= 1) { walk = true; walkAcc -= 1 }
  } else walkAcc = 0
  bot.setControlState('forward', walk)
  bot.setControlState('sprint', walk && (sprint || forward >= 1) && !eating)
  bot.setControlState('back', back)

  if (m.jump && jumpTicks === 0) {
    jumpTicks = 1
    bot.setControlState('jump', true)
    if (s.onGround && Date.now() - lastJumpLog > 2000) { lastJumpLog = Date.now(); log(`jumped${s.mobs.length ? ` (${s.mobs[0].kind} at ${s.mobs[0].dist}, closing ${s.mobs[0].closing})` : ''}`) }
  } else if (jumpTicks > 0) {
    jumpTicks = 0
    bot.setControlState('jump', false)
  }

  if (eat && s.holdingFood > 0 && !eating && !torchInFlight) {
    const item = bot.inventory.items().find((it) => FOOD_POINTS[it.name])
    if (item && bot.food < 20) {
      eating = true
      const pts = FOOD_POINTS[item.name]
      bot.equip(item, 'hand')
        .then(() => bot.consume())
        .then(() => { ateThisTick += pts; log(`ate ${item.name} (+${pts} points) hunger=${bot.food}`) })
        .catch((e) => { if (VERBOSE) warn('eat failed:', e.message) })
        .finally(() => { eating = false })
    } else if (item && !fullWarned) {
      fullWarned = true
      log('holding food but the hunger bar is full: the pickup already counted; it will be eaten when hunger drops')
    }
  }
  if (bot.food < 20) fullWarned = false

  // torch: the request is latched for 3 s and honoured at the first moment the bot stands still (a torch is
  // placed on the block below its feet), at most once per 30 s.
  if (m.torch && now - lastTorchAt >= TORCH_EVERY_MS) torchWantedUntil = Math.max(torchWantedUntil, now + 3000)
  if (torchWantedUntil > now && !torchInFlight && !eating && !walk && !back && s.onGround) {
    const v = bot.entity.velocity
    if (Math.hypot(v.x, v.z) < 0.05) { torchWantedUntil = 0; placeTorch() }
  }
  // `say` is not handled here: it was queued when the motor message arrived (connectBrain) and the tick flushes it
}

function placeTorch () {
  const torch = bot.inventory.items().find((it) => it.name === 'torch')
  if (!torch) { if (VERBOSE) warn('torch: none in the inventory'); lastTorchAt = Date.now(); return }
  const feet = bot.entity.position.floored()
  const below = bot.blockAt(feet.offset(0, -1, 0))
  const here = bot.blockAt(feet)
  if (!below || !here || below.boundingBox !== 'block' || here.name !== 'air') return
  torchInFlight = true
  lastTorchAt = Date.now()
  bot.equip(torch, 'hand')
    .then(() => bot.placeBlock(below, new Vec3(0, 1, 0)))
    .then(() => log(`placed a torch at ${feet.x} ${feet.y} ${feet.z}`))
    .catch((e) => warn('torch failed:', e.message))
    .finally(() => { torchInFlight = false; bot.look(yaw, 0, true).catch(() => {}) })
}

// ---------------------------------------------------------------- the 10 Hz tick
let lastTick = 0
function tick () {
  if (!bot || !spawned || !bot.entity) return
  const now = Date.now()
  const dt = lastTick ? Math.min(0.5, (now - lastTick) / 1000) : TICK_MS / 1000
  lastTick = now
  let s
  try { s = senses() } catch (e) { warn('senses', e.message); return }
  sendSenses(s)
  if (motor && now - motorAt <= MOTOR_TIMEOUT_MS) {
    try { applyMotor(motor, s, dt) } catch (e) { warn('motor', e.message) }
  } else if (motor) {
    motor = null
    bot.clearControlStates()
  }
  flushSay(now) // lines already decided by the brain are said even while it is silent
  if (now - statusAt >= 5000) {
    statusAt = now
    log(`pos=(${s.pos.join(',')}) yaw=${s.yaw} hp=${s.health} hunger=${s.hunger} light=${s.light} night=${s.night} food=${s.food.length} mobs=${s.mobs.length} flies=${s.flies.length} holding=${s.holdingFood} torches=${s.torches} deaths=${deaths} brain=${ws ? 'up' : 'down'}`)
    if (VERBOSE && (s.food.length || s.mobs.length)) log('senses', JSON.stringify({ food: s.food, mobs: s.mobs }))
  }
}

// ---------------------------------------------------------------- the server connection
function connectServer () {
  if (stopping) return
  log(`joining ${HOST}:${PORT} as ${NAME} (mc ${MC_VERSION}), brain ${BRAIN_WS}`)
  bot = mineflayer.createBot({ host: HOST, port: PORT, username: NAME, version: MC_VERSION, auth: 'offline', respawn: true, checkTimeoutInterval: 60_000 })
  spawned = false
  let first = true // the first 'spawn' of this connection is the join; later ones follow a death (respawn packet, then health > 0)

  bot.on('spawn', () => {
    const p = bot.entity.position
    if (!first) {
      // mineflayer emits 'spawn' again when the health packet after the respawn packet arrives, i.e. once the
      // server has already teleported the bot to world spawn: the next tick reports respawned=true from there
      respawnedFlag = true
      mobTrack.clear()
      lastHolding = holdingFood() // keepInventory: the food survives the death; whatever changed is not a meal
      log(`respawned at (${r2(p.x)}, ${r2(p.y)}, ${r2(p.z)}) hp=${bot.health ?? '?'}`)
      return
    }
    first = false
    spawned = true
    serverBackoff = 2000
    yaw = wrap(bot.entity.yaw)
    // bot.health is still undefined here (mineflayer emits 'spawn' from the first health packet before storing
    // it): the first 'health' event below initialises the comparison, so a persisted health < 20 is not a hit
    healthKnown = false
    damageAcc = 0
    hitFlag = false
    hitHeld = false
    diedFlag = false
    respawnedFlag = false
    lastHolding = holdingFood()
    mobTrack.clear()
    lastTick = 0
    log(`spawned at (${r2(p.x)}, ${r2(p.y)}, ${r2(p.z)}) hp=${bot.health ?? '?'} hunger=${bot.food ?? '?'}`)
    if (!tickTimer) tickTimer = setInterval(tick, TICK_MS)
    if (VIEWER_PORT > 0) {
      import('./tools/viewer.mjs')
        .then(({ attachViewer }) => { attachViewer(bot, { port: VIEWER_PORT, prefix: VIEWER_PREFIX, firstPerson: VIEWER_FIRST_PERSON }); log(`viewer on http://127.0.0.1:${VIEWER_PORT}${VIEWER_PREFIX}/`) })
        .catch((e) => warn('viewer failed:', e.message))
    }
  })
  bot.on('respawn', () => { if (spawned) log('respawning…') })
  bot.on('death', () => {
    // the health packet that carried this (health 0) was counted by onHealth just before, so `damage` on the next
    // tick is the killing blow even though the immediate respawn puts the health back to 20 within the same tick
    diedFlag = true
    deaths += 1
    log(`died (damage this tick ${r2(damageAcc)}, death ${deaths})`)
  })
  bot.on('health', () => {
    // every health packet: the first one after joining only sets the baseline, later drops accumulate for the tick
    const h = bot.health
    if (typeof h !== 'number' || !Number.isFinite(h)) return
    if (!healthKnown) { healthKnown = true; lastHealth = h; return }
    if (h < lastHealth - 0.01) damageAcc += lastHealth - h
    lastHealth = h
  })
  bot.on('entityHurt', (entity, source) => {
    if (bot.entity && entity && entity.id === bot.entity.id) {
      hitFlag = true
      if (source && source.name) log(`hit by ${source.name}`)
    }
  })
  bot.on('playerCollect', (collector, collected) => {
    if (bot.entity && collector && collector.id === bot.entity.id) {
      let item = null
      try { item = collected.getDroppedItem() } catch (_) {}
      if (item) log(`picked up ${item.count} x ${item.name}`)
    }
  })
  bot.on('chat', (username, message) => { if (username !== NAME) log(`<${username}> ${message}`) })
  bot.on('kicked', (reason) => warn('kicked:', typeof reason === 'string' ? reason : JSON.stringify(reason)))
  bot.on('error', (e) => warn('server error:', e.message || e))
  bot.on('end', (reason) => {
    log('disconnected', reason || '')
    spawned = false
    try { if (bot && bot.viewer) bot.viewer.close() } catch (_) {}
    bot = null
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null }
    if (!stopping) {
      log(`reconnecting in ${serverBackoff / 1000}s`)
      setTimeout(connectServer, serverBackoff)
      serverBackoff = Math.min(serverBackoff * 2, 60_000)
    }
  })
}

// ---------------------------------------------------------------- shutdown
function shutdown (sig) {
  if (stopping) return
  stopping = true
  log(`${sig}: leaving`)
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null }
  try { if (ws) ws.close() } catch (_) {}
  try { if (bot) { bot.clearControlStates(); bot.quit('the fly left the colony') } } catch (_) {}
  setTimeout(() => process.exit(0), 500).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('uncaughtException', (e) => { warn('uncaught:', e && e.stack ? e.stack : e) })
process.on('unhandledRejection', (e) => { warn('unhandled:', e && e.message ? e.message : e) })

if (!Number.isFinite(FLY_ID) || FLY_ID <= 0) {
  warn('FLY_ID (or --id) must be a positive integer')
  process.exit(2)
}
connectBrain()
connectServer()
