// A cheap summary of a file for the pet's hover card: no model, only heuristics on the first 64 KB.
//   docs (md, d4a, txt, ...): the title, the first paragraph, up to 6 headings
//   code: the leading comment block, up to 8 top-level declaration names
export const MAX_READ = 64 * 1024
const LEAD_CHARS = 200
const MAX_HEADS = 6
const MAX_DECLS = 8

const DOC_EXT = /\.(md|markdown|d4a|txt|rst|adoc)$/i

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s)
const squash = s => s.replace(/\s+/g, ' ').trim()
/** Markdown noise out of a title or lead: emphasis marks, link targets, inline code ticks. */
const plain = s => squash(s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*`]+|~~|(?<![A-Za-z0-9])_+|_+(?![A-Za-z0-9])/g, ''))

export function isDoc(path) {
  return DOC_EXT.test(path)
}

/** Title, lead paragraph and headings of a text document. */
function summarizeDoc(text) {
  const lines = text.split(/\r?\n/)
  let i = 0
  // Front matter ("---" ... "---") is not content.
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, k) => k > 0 && l.trim() === '---')
    if (end > 0) i = end + 1
  }
  const heads = []
  let title = ''
  let titleAt = -1
  let inFence = false
  for (let k = i; k < lines.length; k += 1) {
    const line = lines[k] ?? ''
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
    if (!m) continue
    if (titleAt < 0) {
      title = plain(m[1] ?? '')
      titleAt = k
    } else if (heads.length < MAX_HEADS) heads.push(plain(m[1] ?? ''))
  }
  if (titleAt < 0) {
    // No heading: the first non-empty line stands in for the title.
    const k = lines.findIndex((l, n) => n >= i && l.trim() !== '')
    if (k >= 0) {
      title = plain(lines[k] ?? '')
      titleAt = k
    }
  }
  // The first paragraph after the title: plain lines up to a blank line, a heading or a fence.
  const para = []
  inFence = false
  for (let k = titleAt + 1; k < lines.length && k >= 0; k += 1) {
    const line = lines[k] ?? ''
    if (/^\s*(```|~~~)/.test(line)) {
      if (para.length) break
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (line.trim() === '') {
      if (para.length) break
      continue
    }
    if (/^#{1,6}\s/.test(line) || /^\s*(\||---|===)/.test(line)) {
      if (para.length) break
      continue
    }
    para.push(line.replace(/^\s*[-*>]\s+/, ''))
  }
  return { kind: 'doc', title: clip(title, 100), lead: clip(plain(para.join(' ')), LEAD_CHARS), heads, decls: [] }
}

/** The comment block at the top of a source file, with its comment marks taken off. */
function leadingComment(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  let i = 0
  if (lines[0]?.startsWith('#!')) i = 1
  while (i < lines.length && (lines[i] ?? '').trim() === '') i += 1
  const first = (lines[i] ?? '').trim()
  const out = []
  if (first.startsWith('/*')) {
    for (; i < lines.length; i += 1) {
      const line = lines[i] ?? ''
      out.push(line.replace(/^\s*\/\*+!?|\*+\/\s*$|^\s*\*+ ?/g, ''))
      if (line.includes('*/')) break
    }
  } else if (/^(\/\/+|#(?!\s*(include|define|if|pragma|import))|--|;|%)/.test(first)) {
    for (; i < lines.length; i += 1) {
      const t = (lines[i] ?? '').trim()
      if (!/^(\/\/+|#+|--|;+|%+)/.test(t)) break
      out.push(t.replace(/^(\/\/+|#+|--|;+|%+)\s?/, ''))
    }
  } else if (/^("""|''')/.test(first)) {
    const q = first.slice(0, 3)
    const start = i
    for (; i < lines.length; i += 1) {
      const line = lines[i] ?? ''
      out.push(line.replace(/"""|'''/g, ''))
      const n = line.split(q).length - 1
      if (i === start ? n >= 2 : n >= 1) break
    }
  }
  return squash(out.join(' '))
}

// Top-level declarations: flush-left, so a nested helper or a method is not listed.
const DECL_RES = [
  /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/,
  /^(?:export\s+)(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
  /^(?:async\s+)?def\s+([A-Za-z_]\w*)/,
  /^class\s+([A-Za-z_]\w*)/,
  /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/,
  /^(?:pub\s+)?(?:struct|enum|trait|impl|mod)\s+([A-Za-z_]\w*)/,
  /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
  /^(?:typedef\s+)?(?:struct|union|enum|class)\s+(?:[A-Z_]+_API\s+)?([A-Za-z_]\w*)/,
  /^(?:public|internal|private|protected)?\s*(?:static\s+)?(?:sealed\s+)?(?:partial\s+)?(?:class|struct|interface|record|enum)\s+([A-Za-z_]\w*)/,
  /^(?:module\.exports\.|exports\.)([A-Za-z_$][\w$]*)\s*=/,
]

function summarizeCode(text) {
  const decls = []
  for (const line of text.split(/\r?\n/)) {
    if (decls.length >= MAX_DECLS) break
    if (line === '' || /^\s/.test(line)) continue
    for (const re of DECL_RES) {
      const m = re.exec(line)
      if (m?.[1]) {
        if (!decls.includes(m[1])) decls.push(m[1])
        break
      }
    }
  }
  return { kind: 'code', title: '', lead: clip(leadingComment(text), LEAD_CHARS), heads: [], decls }
}

/** The summary of `text`, a file's first bytes; `path` only picks docs from code by extension. */
export function summarize(text, path) {
  const t = text.replace(/^﻿/, '')
  return isDoc(path) ? summarizeDoc(t) : summarizeCode(t)
}

/**
 * Reads the first 64 KB of a regular file and summarizes it. Never reads more, and refuses anything that is not
 * a plain file (a directory, a pipe, a device). Resolves `{ error }` rather than throwing. `fs` is node's `fs`
 * (openSync, fstatSync, readSync, closeSync): handed in, so this module imports nothing.
 */
export function summarizeFile(path, fs) {
  let fd = -1
  try {
    fd = fs.openSync(path, 'r')
    const st = fs.fstatSync(fd)
    if (!st.isFile()) return { error: 'not a regular file' }
    const buf = new Uint8Array(Math.min(MAX_READ, st.size))
    const n = buf.length ? fs.readSync(fd, buf, 0, buf.length, 0) : 0
    const out = summarize(new TextDecoder().decode(buf.subarray(0, n)), path)
    return { ...out, size: st.size, mtimeMs: st.mtimeMs, truncated: st.size > MAX_READ }
  } catch (e) {
    return { error: String(e && e.code ? e.code : 'unreadable') }
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd)
      } catch {
        /* nothing to do */
      }
    }
  }
}
