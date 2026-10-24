// In-memory library of positions and sequences, saved to disk through the
// main process (debounced) after every change.

import { emptyLibrary, uid, type Library, type Position, type Sequence } from '@shared/types'
import { emit } from './core'
import { confirmDialog, promptText } from './dialog'

export const lib: Library = emptyLibrary()
let saveTimer: ReturnType<typeof setTimeout> | undefined

export async function loadLibrary() {
  Object.assign(lib, await window.movens.library.load())
  emit('library', undefined)
}

/** Call after mutating lib; persists shortly after and notifies the views */
export function changed() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => window.movens.library.save(structuredClone(lib)), 300)
  emit('library', undefined)
}

export const findPosition = (id: string) => lib.positions.find(p => p.id === id)
export const findSequence = (id: string) => lib.sequences.find(s => s.id === id)

/** Next free default name: P1, P2, ... */
export function nextName(prefix: string, names: string[]): string {
  let n = 1
  while (names.includes(prefix + n)) n++
  return prefix + n
}

// ── Position names ───────────────────────────────────────────────────────────
// Names are unique (ignoring case and surrounding spaces): sequences and the
// list show positions by name, so two of the same name can't be told apart.

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/** The position with this name, other than the one with id `exceptId` */
export const positionNamed = (name: string, exceptId?: string) =>
  lib.positions.find(p => p.id !== exceptId && sameName(p.name, name))

/** `base`, or `base (2)`, `base (3)`, ... whichever is free */
export function freePositionName(base: string): string {
  if (!positionNamed(base)) return base
  let n = 2
  while (positionNamed(`${base} (${n})`)) n++
  return `${base} (${n})`
}

/** Ask whether to replace the position `other` with one of the same name */
export function confirmReplace(other: Position): Promise<boolean> {
  const used = sequencesUsing(other.id).length
  return confirmDialog(`A position named "${other.name}" already exists.` +
    (used ? `\nIts ${used === 1 ? 'sequence' : `${used} sequences`} will use the new one.` : '') +
    '\nReplace it?', 'Replace', true)
}

/** Ask for a name for position `selfId` (a new one when omitted). A name
 *  already taken asks to replace that position; declining asks again. */
export async function askPositionName(title: string, value: string, okLabel = 'Save', selfId?: string): Promise<string | null> {
  for (;;) {
    const name = await promptText(title, value, okLabel)
    if (!name) return null
    const other = positionNamed(name, selfId)
    if (!other || await confirmReplace(other)) return name
    value = name
  }
}

/** Put `p` in the library (new, or updating its own entry). Another position
 *  of the same name is replaced: `p` takes its place in the list and in the
 *  sequences that used it. Call changed() after. */
export function putPosition(p: Position) {
  const other = positionNamed(p.name, p.id)
  const i = lib.positions.findIndex(x => x.id === p.id)
  if (other) {
    for (const s of lib.sequences) for (const st of s.steps)
      if (st.type === 'move' && st.positionId === other.id) st.positionId = p.id
    lib.positions[lib.positions.indexOf(other)] = p
    if (i >= 0) lib.positions.splice(i, 1)
  } else if (i >= 0) lib.positions[i] = p
  else lib.positions.push(p)
}

/** Sequences whose steps use the position */
export const sequencesUsing = (posId: string) =>
  lib.sequences.filter(s => s.steps.some(st => st.type === 'move' && st.positionId === posId))

// ── Import / export ──────────────────────────────────────────────────────────
// File format: {kind:'movens-link', positions, sequences}. A single exported
// sequence carries the positions it uses. Files exported before the rename
// say 'moveo-link'.

export function exportData(seq?: Sequence) {
  if (!seq) return { kind: 'movens-link', version: 1, positions: lib.positions, sequences: lib.sequences }
  const ids = new Set(seq.steps.flatMap(s => (s.type === 'move' ? [s.positionId] : [])))
  return { kind: 'movens-link', version: 1, positions: lib.positions.filter(p => ids.has(p.id)), sequences: [seq] }
}

const isPosition = (p: any): p is Position =>
  p && typeof p.id === 'string' && typeof p.name === 'string' && (p.kind === 'joints' || p.kind === 'pose')
const isSequence = (s: any): s is Sequence =>
  s && typeof s.id === 'string' && typeof s.name === 'string' && Array.isArray(s.steps)

/** Names of the file's positions that are already taken */
function nameClashes(data: any): string[] {
  const names = (data?.positions || []).filter(isPosition).map((p: Position) => p.name) as string[]
  return names.filter((n, i) => positionNamed(n) || names.findIndex(m => sameName(m, n)) < i)
}

/** Import a library file; positions whose names are taken either replace
 *  those (when the user agrees) or get a free name. Returns counts or an
 *  error, or null when cancelled. */
export async function importLibrary(data: any): Promise<{ positions: number; sequences: number } | string | null> {
  const bad = checkFile(data)
  if (bad) return bad
  const clash = nameClashes(data)
  let replace = false
  if (clash.length) {
    const list = clash.length > 6 ? clash.slice(0, 6).join(', ') + ', ...' : clash.join(', ')
    replace = await confirmDialog(`${clash.length === 1 ? 'A position' : `${clash.length} positions`} in the file ` +
      `${clash.length === 1 ? 'has a name' : 'have names'} already in use: ${list}.\n` +
      'Replace the existing ones, or keep both (the imported ones get new names)?', 'Replace', true, 'Keep both')
  }
  return importData(data, replace)
}

const checkFile = (data: any): string | null =>
  !data || data.error ? data?.error || 'Nothing to import'
    : data.kind !== 'movens-link' && data.kind !== 'moveo-link' ? 'Not a Movens Link file' : null

/** Merge imported data; clashing ids get new ones, and positions with a name
 *  already taken replace that position or get a free name. Returns counts or
 *  an error. */
export function importData(data: any, replaceNames = false): { positions: number; sequences: number } | string {
  const bad = checkFile(data)
  if (bad) return bad
  const positions: Position[] = (data.positions || []).filter(isPosition)
  const sequences: Sequence[] = (data.sequences || []).filter(isSequence)
  const remap = new Map<string, string>()
  const posIds = new Set(lib.positions.map(p => p.id))
  for (const p of positions) {
    const copy = structuredClone(p)
    if (posIds.has(copy.id)) { remap.set(copy.id, uid()); copy.id = remap.get(p.id)! }
    if (!replaceNames) copy.name = freePositionName(copy.name)
    putPosition(copy)
  }
  const seqIds = new Set(lib.sequences.map(s => s.id))
  for (const s of sequences) {
    const copy = structuredClone(s)
    if (seqIds.has(copy.id)) copy.id = uid()
    for (const st of copy.steps) {
      if (!st.id) st.id = uid()
      if (st.type === 'move' && remap.has(st.positionId)) st.positionId = remap.get(st.positionId)!
    }
    lib.sequences.push(copy)
  }
  changed()
  return { positions: positions.length, sequences: sequences.length }
}
