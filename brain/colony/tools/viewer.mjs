#!/usr/bin/env node
// viewer.mjs: a prismarine-viewer for a bot.
//
// As a module (agent.mjs uses it when VIEWER_PORT is set): attachViewer(bot, {port, prefix, firstPerson, viewDistance})
// serves the browser viewer of that bot's world on http://127.0.0.1:<port><prefix>/ (the supervisor proxies it under
// /fly/<id>/view/; pass prefix '/fly/<id>/view' so the page's socket.io path matches the proxied path).
//
// As a program: a follower camera. It joins as a spectator-style bot (default name cam<id>; whitelist it, and
// `gamemode spectator cam<id>` over RCON so it neither collides nor gets attacked) that hovers behind and above
// the fly it follows and serves that view:
//
//   node tools/viewer.mjs --follow fly12 --port 3012 [--name cam12] [--prefix /fly/12/view] [--host 127.0.0.1 --port-mc 25565]
//
// The camera is first-person (the page follows the bot), so the fly stays in frame as it walks.

import mineflayer from 'mineflayer'
import { Vec3 } from 'vec3'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

// prismarine-viewer's own mineflayer plugin, minus its drawing primitives, listening on 127.0.0.1 only (the library
// binds every interface; nothing of the Colony is public except through the supervisor's proxy).
export function attachViewer (bot, { port = 3000, prefix = '', firstPerson = true, viewDistance = 6, host = '127.0.0.1' } = {}) {
  const { WorldView } = require('prismarine-viewer/viewer')
  const { setupRoutes } = require('prismarine-viewer/lib/common')
  const express = require('express')
  const app = express()
  const http = require('http').createServer(app)
  const io = require('socket.io')(http, { path: prefix + '/socket.io' })
  setupRoutes(app, prefix)
  const sockets = []
  io.on('connection', (socket) => {
    if (!bot.entity) { socket.disconnect(); return }
    socket.emit('version', bot.version)
    sockets.push(socket)
    const worldView = new WorldView(bot.world, viewDistance, bot.entity.position, socket)
    worldView.init(bot.entity.position)
    function botPosition () {
      const packet = { pos: bot.entity.position, yaw: bot.entity.yaw, addMesh: true }
      if (firstPerson) packet.pitch = bot.entity.pitch
      socket.emit('position', packet)
      worldView.updatePosition(bot.entity.position)
    }
    bot.on('move', botPosition)
    worldView.listenToBot(bot)
    socket.on('disconnect', () => {
      bot.removeListener('move', botPosition)
      worldView.removeListenersFromBot(bot)
      sockets.splice(sockets.indexOf(socket), 1)
    })
  })
  http.listen(port, host)
  const viewer = {
    port,
    prefix,
    close () {
      for (const socket of sockets.slice()) socket.disconnect(true)
      io.close()
      http.close()
    }
  }
  bot.viewer = viewer
  return viewer
}

// Keeps a bot hovering: no gravity, and every 100 ms it moves a step toward `target()` (a Vec3 or null) and looks
// along `look()` ({yaw, pitch}). Returns a stop function.
export function hover (bot, target, look, { speed = 0.4 } = {}) {
  bot.physics.gravity = 0
  const timer = setInterval(() => {
    if (!bot.entity) return
    bot.physics.gravity = 0
    bot.entity.velocity = new Vec3(0, 0, 0)
    const t = target()
    if (t) {
      const d = t.minus(bot.entity.position)
      const m = Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z)
      if (m > 0.05) bot.entity.position.add(d.scaled(Math.min(1, speed / m)))
    }
    const l = look()
    if (l) bot.look(l.yaw, l.pitch, true).catch(() => {})
  }, 100)
  return () => clearInterval(timer)
}

// yaw (mineflayer radians) that faces from `from` toward `to`
export function yawToward (from, to) {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z))
}

export function argOf (flag, env, dflt) {
  const i = process.argv.indexOf(flag)
  if (i !== -1 && process.argv[i + 1] !== undefined) return process.argv[i + 1]
  return process.env[env] !== undefined && process.env[env] !== '' ? process.env[env] : dflt
}

// A small reconnecting bot runner shared by the camera tools. `onSpawn(bot)` returns a cleanup function.
export function runCameraBot ({ name, host, port, version, log }, onSpawn) {
  let stopping = false
  let backoff = 2000
  let bot = null
  let cleanup = null
  function connect () {
    if (stopping) return
    log(`joining ${host}:${port} as ${name}`)
    bot = mineflayer.createBot({ host, port, username: name, version, auth: 'offline', respawn: true, checkTimeoutInterval: 60_000 })
    bot.once('spawn', () => {
      backoff = 2000
      log(`spawned at ${bot.entity.position.floored()}`)
      cleanup = onSpawn(bot)
    })
    bot.on('kicked', (r) => log('kicked:', typeof r === 'string' ? r : JSON.stringify(r)))
    bot.on('error', (e) => log('error:', e.message || e))
    bot.on('end', (reason) => {
      log('disconnected', reason || '')
      if (cleanup) { try { cleanup() } catch (_) {} cleanup = null }
      bot = null
      if (!stopping) {
        log(`reconnecting in ${backoff / 1000}s`)
        setTimeout(connect, backoff)
        backoff = Math.min(backoff * 2, 60_000)
      }
    })
  }
  function shutdown (sig) {
    if (stopping) return
    stopping = true
    log(`${sig}: leaving`)
    if (cleanup) { try { cleanup() } catch (_) {} cleanup = null }
    try { if (bot) bot.quit('camera off') } catch (_) {}
    setTimeout(() => process.exit(0), 500).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('uncaughtException', (e) => log('uncaught:', e && e.stack ? e.stack : e))
  process.on('unhandledRejection', (e) => log('unhandled:', e && e.message ? e.message : e))
  connect()
}

// ---------------------------------------------------------------- the follower camera (CLI)
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())
if (isMain) {
  const follow = argOf('--follow', 'FOLLOW', '')
  if (!follow) {
    console.error('usage: viewer.mjs --follow fly<id> --port <viewer port> [--name cam<id>] [--prefix /fly/<id>/view] [--host 127.0.0.1] [--port-mc 25565]')
    process.exit(2)
  }
  const id = (/^fly(\d+)$/.exec(follow) || [])[1] || ''
  const name = String(argOf('--name', 'NAME', `cam${id || follow}`)).slice(0, 16)
  const viewerPort = parseInt(argOf('--port', 'VIEWER_PORT', '3000'), 10)
  const prefix = argOf('--prefix', 'VIEWER_PREFIX', '')
  const host = argOf('--host', 'SERVER_HOST', '127.0.0.1')
  const mcPort = parseInt(argOf('--port-mc', 'SERVER_PORT', '25565'), 10)
  const version = argOf('--version', 'MC_VERSION', '1.21.4')
  const log = (...a) => console.log(`[${name} ${new Date().toISOString().slice(11, 19)}]`, ...a)
  const home = new Vec3(0, 64 + 6, 0)
  let lastSeen = 0

  runCameraBot({ name, host, port: mcPort, version, log }, (bot) => {
    const viewer = attachViewer(bot, { port: viewerPort, prefix, firstPerson: true })
    log(`viewer on http://127.0.0.1:${viewerPort}${prefix}/ following ${follow}`)
    const fly = () => bot.players[follow] && bot.players[follow].entity
    const stop = hover(bot, () => {
      const f = fly()
      if (!f) return Date.now() - lastSeen > 10_000 ? home : null
      lastSeen = Date.now()
      // 5 blocks behind the fly (along its heading) and 3 up
      const back = new Vec3(Math.sin(f.yaw), 0, Math.cos(f.yaw)).scaled(5)
      return f.position.plus(back).offset(0, 3, 0)
    }, () => {
      const f = fly()
      if (!f) return { yaw: 0, pitch: -Math.PI / 4 }
      const eye = f.position.offset(0, 1.2, 0)
      const d = eye.minus(bot.entity.position)
      const horiz = Math.hypot(d.x, d.z)
      return { yaw: yawToward(bot.entity.position, eye), pitch: Math.atan2(d.y, horiz) }
    })
    return () => { stop(); try { viewer.close() } catch (_) {} }
  })
}
