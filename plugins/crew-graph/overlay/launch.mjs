#!/usr/bin/env node
// Starts (or stops) the desktop pet so that it outlives the session that asked for it.
//
//   node launch.mjs --electron <electron binary> --main <main.js> --page <index.html> --state <dir> [--session <id>] [--token <token>] [--orca]
//   node launch.mjs --state <dir> --close <session id>      close that session's window
//   node launch.mjs --state <dir> --quit                    quit the pet, every window
//
// Start: spawns Electron detached with no stdio and prints `ok <pid>`. The pet is one process with a window per
// session: a second start only hands its --session and --token to the running one (it opens that session's window, or wakes
// it, and takes the new token). The token is a secret the mod made for that window: the window repeats it in the requests it writes
// to the mod's inbox (ask, dismiss, stop), and the mod ignores a request without it. Close and quit write <state>/close-<id> and <state>/quit, which the running pet watches for.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const arg = name => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : ''
}
const flag = name => argv.includes(`--${name}`)
const fail = msg => {
  process.stdout.write(`error ${msg}\n`)
  process.exit(1)
}

const state = arg('state')
if (!state) fail('no --state given')
mkdirSync(state, { recursive: true })
const quitFile = join(state, 'quit')
const session = arg('session')
// A session id becomes part of a file name: ids of the usual kind only.
const okId = id => /^[A-Za-z0-9._-]{1,80}$/.test(id)
// The token is made by the mod: letters and digits only.
const okToken = t => /^[A-Za-z0-9]{16,64}$/.test(t)

if (flag('close')) {
  const id = arg('close')
  if (!okId(id)) fail('--close needs a session id')
  writeFileSync(join(state, `close-${id}`), String(Date.now()))
  process.stdout.write('ok\n')
  process.exit(0)
}

if (flag('quit')) {
  writeFileSync(quitFile, String(Date.now()))
  process.stdout.write('ok\n')
  process.exit(0)
}

const electron = arg('electron')
const main = arg('main')
const page = arg('page')
if (!electron || !existsSync(electron)) fail(`electron not found: ${electron || '(none)'}`)
if (!main || !existsSync(main)) fail(`main.js not found: ${main || '(none)'}`)
if (!page || !existsSync(page)) fail(`page not found: ${page || '(none)'}`)

// A quit or close request left behind by a `/crew pet off` that found nothing running would close the next pet at once.
rmSync(quitFile, { force: true })
if (okId(session)) rmSync(join(state, `close-${session}`), { force: true })

const args = [main, '--page', page, '--state', state]
if (okId(session)) args.push('--session', session)
if (okId(session) && okToken(arg('token'))) args.push('--token', arg('token'))
if (flag('orca')) args.push('--orca')
// Detached, no stdio: nothing ties the pet to this process, and a caller that reads this process's output
// is not held open by the pet's own handles.
const child = spawn(electron, args, { detached: true, stdio: 'ignore', windowsHide: false })
// Report only once the process really started; `unref` lets this one leave without it.
child.once('error', e => fail(e.message))
child.once('spawn', () => {
  child.unref()
  process.stdout.write(`ok ${child.pid}\n`, () => process.exit(0))
})
