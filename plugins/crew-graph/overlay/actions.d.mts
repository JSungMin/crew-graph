// Types for actions.mjs (what the pet may do with a file), for the tests that import it.
export function norm(p: unknown, platform?: string): string | null
export function parseDataJs(text: string): { files?: { abs?: string }[] } | null
export function allowedFiles(snapshot: unknown, platform?: string): Map<string, string>
export function isOpenable(path: string): boolean
export function makeActions(deps: {
  shell: { openPath(p: string): Promise<string> | string; showItemInFolder(p: string): void }
  execFile(file: string, args: string[], opts: object, cb: (err: Error | null) => void): unknown
  files(): Map<string, string>
  platform?: string
  orca: boolean
  isFile(p: string): boolean
}): {
  resolve(abs: unknown): string | null
  open(abs: unknown): Promise<'orca' | 'shell' | 'reveal' | 'denied' | 'missing' | 'failed'>
  reveal(abs: unknown): Promise<'reveal' | 'denied' | 'missing'>
}
