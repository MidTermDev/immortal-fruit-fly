#!/usr/bin/env node
// camera.mjs: the colony camera. A bot named flycam hovers above and beside the flies, looking down at them at an angle, and its
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
const height = parseFloat(argOf('--height', 'CAM_HEIGHT', '14'))
const back = parseFloat(argOf('--back', 'CAM_BACK', '16'))   // the camera sits this far south-west of the flies and looks at them: a perspective view, not a map
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
    return new Vec3(cx - back * 0.7, SURFACE_Y + height, cz + back * 0.7)
  }, () => {
    // look from the camera's own position at the centroid on the ground (the same target the position tracks)
    const flies = Object.values(bot.players).filter((p) => p.entity && /^fly\d+$/.test(p.username)).map((p) => p.entity.position)
    let cx = 0; let cz = 0
    if (flies.length) { for (const p of flies) { cx += p.x; cz += p.z } cx /= flies.length; cz /= flies.length }
    const pos = bot.entity ? bot.entity.position : new Vec3(cx - back * 0.7, SURFACE_Y + height, cz + back * 0.7)
    const dx = cx - pos.x; const dz = cz - pos.z; const dy = SURFACE_Y - pos.y
    const yaw = Math.atan2(-dx, -dz)   // minecraft yaw: 0 = south (+z), positive toward west (-x)
    const pitch = Math.atan2(dy, Math.sqrt(dx * dx + dz * dz))   // negative = looking down
    return { yaw, pitch }
  }, { speed: 0.3 })
  return () => { stop(); try { viewer.close() } catch (_) {} }
})
