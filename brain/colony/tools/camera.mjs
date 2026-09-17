#!/usr/bin/env node
// camera.mjs: the colony camera. A bot named flycam hovers high above the flies, looking straight down, and its
// prismarine-viewer is the overview the site embeds at /view/.
//
//   node tools/camera.mjs [--port 3100] [--prefix /view] [--height 40] [--name flycam] [--host 127.0.0.1 --port-mc 25565]
//
// The supervisor whitelists the name and puts it in spectator mode over RCON (`gamemode spectator flycam`): it then
// neither collides with nor is seen by anything. The camera drifts toward the centroid of the visible fly<n> players
// (or back over the spawn glade at 0,64,0 when none are in sight), so the overview always shows the colony.

import { Vec3 } from 'vec3'
import { attachViewer, hover, argOf, runCameraBot } from './viewer.mjs'

const name = String(argOf('--name', 'NAME', 'flycam')).slice(0, 16)
const viewerPort = parseInt(argOf('--port', 'VIEWER_PORT', '3100'), 10)
const prefix = argOf('--prefix', 'VIEWER_PREFIX', '')
const height = parseFloat(argOf('--height', 'CAM_HEIGHT', '40'))
const host = argOf('--host', 'SERVER_HOST', '127.0.0.1')
const mcPort = parseInt(argOf('--port-mc', 'SERVER_PORT', '25565'), 10)
const version = argOf('--version', 'MC_VERSION', '1.21.4')
const SURFACE_Y = parseFloat(argOf('--surface', 'SURFACE_Y', '64'))
const log = (...a) => console.log(`[${name} ${new Date().toISOString().slice(11, 19)}]`, ...a)

runCameraBot({ name, host, port: mcPort, version, log }, (bot) => {
  const viewer = attachViewer(bot, { port: viewerPort, prefix, firstPerson: true, viewDistance: 6 })
  log(`overview on http://127.0.0.1:${viewerPort}${prefix}/ at ${height} blocks up`)
  let statusAt = 0
  const stop = hover(bot, () => {
    const flies = Object.values(bot.players).filter((p) => p.entity && /^fly\d+$/.test(p.username)).map((p) => p.entity.position)
    let cx = 0; let cz = 0
    if (flies.length) {
      for (const p of flies) { cx += p.x; cz += p.z }
      cx /= flies.length; cz /= flies.length
    }
    if (Date.now() - statusAt > 10_000) {
      statusAt = Date.now()
      log(`over (${cx.toFixed(1)}, ${cz.toFixed(1)}), ${flies.length} flies in sight: ${Object.keys(bot.players).filter((n) => /^fly\d+$/.test(n)).join(' ') || '-'}`)
    }
    return new Vec3(cx, SURFACE_Y + height, cz)
  }, () => ({ yaw: 0, pitch: -Math.PI / 2 }), { speed: 0.3 })
  return () => { stop(); try { viewer.close() } catch (_) {} }
})
