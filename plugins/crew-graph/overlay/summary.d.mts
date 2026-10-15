// Types for summary.mjs (the pet's file summaries), for the tests that import it.
export const MAX_READ: number
export type Summary =
  | { kind: 'doc' | 'code'; title: string; lead: string; heads: string[]; decls: string[]; size?: number; mtimeMs?: number; truncated?: boolean }
  | { error: string }
export function isDoc(path: string): boolean
export function summarize(text: string, path: string): { kind: 'doc' | 'code'; title: string; lead: string; heads: string[]; decls: string[] }
export function summarizeFile(path: string, fs: unknown): Summary
