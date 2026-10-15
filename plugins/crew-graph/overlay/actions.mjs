// What the pet may do with a file, kept apart from Electron so it can be tested with stand-ins.
// The rule that matters: the main process touches a path only if the current snapshot (data.js) lists it
// in files[].abs. Anything else, however it got here, is refused.
/** A path in one comparable spelling (separators, dot segments, case on Windows); null unless it is absolute. */
export function norm(p, platform = process.platform) {
  if (typeof p !== 'string' || p === '' || p.includes('\0')) return null
  const isWin = platform === 'win32'
  const isAbs = isWin ? /^[A-Za-z]:[\\/]/.test(p) : p.startsWith('/')
  if (!isAbs) return null
  // Dot segments are resolved by hand, so this module imports nothing.
  const slashed = isWin ? p.replace(/\\/g, '/') : p
  const drive = isWin ? slashed.slice(0, 2) : ''
  const stack = []
  for (const seg of slashed.slice(drive.length).split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') stack.pop()
    else stack.push(seg)
  }
  const n = `${drive}/${stack.join('/')}`
  return isWin ? n.toLowerCase() : n
}

/** The snapshot data.js carries: `window.__crewUpdate && window.__crewUpdate({...});`. Null when it does not parse. */
export function parseDataJs(text) {
  const mark = '&& window.__crewUpdate('
  const at = typeof text === 'string' ? text.indexOf(mark) : -1
  if (at < 0) return null
  try {
    return JSON.parse(text.slice(at + mark.length, text.lastIndexOf(')')))
  } catch {
    return null
  }
}

/** normalised path -> the path as the snapshot spells it, for every files[].abs. */
export function allowedFiles(snapshot, platform = process.platform) {
  const out = new Map()
  const list = snapshot && Array.isArray(snapshot.files) ? snapshot.files : []
  for (const f of list) {
    const n = f && typeof f.abs === 'string' ? norm(f.abs, platform) : null
    if (n) out.set(n, f.abs)
  }
  return out
}

// Opening hands the file to whatever the OS associates with it: only types that open in a viewer or an editor.
// Anything else (scripts, programs, shortcuts, unknown types) is shown in the file manager instead of run.
const OPENABLE = new Set(
  'md markdown txt d4a rst adoc json jsonc yaml yml toml ini cfg conf log csv tsv xml html htm css scss ts tsx jsx mjs cjs c h cc cpp hpp cs java kt go rs swift sql gradle cmake lock png jpg jpeg gif webp svg pdf'.split(' '),
)

export const isOpenable = p => OPENABLE.has((/\.([A-Za-z0-9]+)$/.exec(p)?.[1] ?? '').toLowerCase())

/**
 * deps: { shell: { openPath, showItemInFolder }, execFile, files(): Map, platform, orca: boolean, isFile(path): boolean }
 * Each action resolves to a word saying what happened: 'orca' | 'shell' | 'reveal' | 'denied' | 'missing' | 'failed'.
 */
export function makeActions(deps) {
  const real = abs => {
    const n = norm(abs, deps.platform)
    return (n && deps.files().get(n)) || null
  }
  const viaOrca = file =>
    new Promise(resolve => {
      deps.execFile('orca', ['file', 'open', file, '--focus'], { windowsHide: true, timeout: 8000 }, err => resolve(!err))
    })
  return {
    resolve: real,
    async open(abs) {
      const file = real(abs)
      if (!file) return 'denied'
      if (!deps.isFile(file)) return 'missing'
      if (deps.orca && (await viaOrca(file))) return 'orca'
      if (!isOpenable(file)) {
        deps.shell.showItemInFolder(file)
        return 'reveal'
      }
      const err = await deps.shell.openPath(file)
      return err ? 'failed' : 'shell'
    },
    async reveal(abs) {
      const file = real(abs)
      if (!file) return 'denied'
      if (!deps.isFile(file)) return 'missing'
      deps.shell.showItemInFolder(file)
      return 'reveal'
    },
  }
}
