import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { JsonStore } from '../src/main/store'
import { normalizeHost } from '../src/main/robot'
import type { Library } from '../src/shared/types'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'movens-link-')); dirs.push(d); return d }
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

describe('JsonStore', () => {
  it('starts empty and round-trips the library', async () => {
    const store = new JsonStore(tmp())
    expect(await store.loadLibrary()).toEqual({ version: 1, positions: [], sequences: [] })
    const lib: Library = {
      version: 1,
      positions: [{ id: 'p', name: 'P1', kind: 'joints', joints: { unit: 'deg', v: [1, 2, 3, 4, 5] }, gripper: 1500, updatedAt: 1 }],
      sequences: [{ id: 's', name: 'S', repeat: 2, steps: [{ id: 'x', type: 'wait', ms: 100 }], updatedAt: 1 }]
    }
    await store.saveLibrary(lib)
    expect(await store.loadLibrary()).toEqual(lib)
  })

  it('survives a corrupt file', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'library.json'), '{nope')
    expect((await new JsonStore(dir).loadLibrary()).positions).toEqual([])
  })

  it('keeps settings with a default host', async () => {
    const store = new JsonStore(tmp())
    expect((await store.loadSettings()).host).toBe('192.168.4.1')
    await store.saveSettings({ host: 'localhost:8080' })
    expect((await store.loadSettings()).host).toBe('localhost:8080')
  })
})

describe('normalizeHost', () => {
  it('strips scheme and slashes', () => {
    expect(normalizeHost(' http://192.168.4.1/ ')).toBe('192.168.4.1')
    expect(normalizeHost('')).toBe('192.168.4.1')
  })
})

describe('library import', () => {
  beforeAll(() => {
    ;(globalThis as any).window = { movens: { library: { save: async () => {} } } }
  })

  it('merges files and remaps clashing ids', async () => {
    const { lib, importData } = await import('../src/renderer/lib/library')
    lib.positions.push({ id: 'p1', name: 'Mine', kind: 'joints', joints: { unit: 'deg', v: [0, 0, 0, 0, 0] }, gripper: null, updatedAt: 0 })
    const r = importData({
      kind: 'movens-link',
      positions: [{ id: 'p1', name: 'Theirs', kind: 'pose', pose: { x: 1, y: 2, z: 3, pitch: 0 }, gripper: null, updatedAt: 0 }],
      sequences: [{ id: 's1', name: 'Seq', repeat: 1, updatedAt: 0, steps: [{ id: 'a', type: 'move', positionId: 'p1', speed: 50, dwellMs: 0 }] }]
    })
    expect(r).toEqual({ positions: 1, sequences: 1 })
    expect(lib.positions).toHaveLength(2)
    const theirs = lib.positions.find(p => p.name === 'Theirs')!
    expect(theirs.id).not.toBe('p1')
    const step = lib.sequences[0].steps[0]
    expect(step.type === 'move' && step.positionId).toBe(theirs.id)
    expect(importData({ hello: 1 })).toBe('Not a Movens Link file')
    expect(importData({ kind: 'moveo-link', positions: [], sequences: [] })).toEqual({ positions: 0, sequences: 0 })
  })

  it('keeps position names unique', async () => {
    const { lib, importData, putPosition, freePositionName } = await import('../src/renderer/lib/library')
    lib.positions.length = 0
    lib.sequences.length = 0
    const pos = (id: string, name: string) =>
      ({ id, name, kind: 'joints' as const, joints: { unit: 'deg' as const, v: [0, 0, 0, 0, 0] }, gripper: null, updatedAt: 0 })
    lib.positions.push(pos('a', 'Home'), pos('b', 'Pick'))
    lib.sequences.push({ id: 's', name: 'S', repeat: 1, updatedAt: 0, steps: [{ id: 'x', type: 'move', positionId: 'a', speed: 50, dwellMs: 0 }] })
    expect(freePositionName('home')).toBe('home (2)')
    expect(freePositionName('Place')).toBe('Place')

    // A new position named like an existing one takes its place and its steps
    putPosition(pos('c', ' HOME '))
    expect(lib.positions.map(p => p.id)).toEqual(['c', 'b'])
    expect((lib.sequences[0].steps[0] as any).positionId).toBe('c')

    // Renaming onto another name replaces that one
    putPosition({ ...lib.positions[1], name: 'Home' })
    expect(lib.positions.map(p => p.id)).toEqual(['b'])
    expect((lib.sequences[0].steps[0] as any).positionId).toBe('b')

    // Imports keep both by default, or replace
    const file = { kind: 'movens-link', positions: [pos('d', 'Home')], sequences: [] }
    importData(file)
    expect(lib.positions.map(p => p.name)).toEqual(['Home', 'Home (2)'])
    importData({ ...file, positions: [pos('e', 'home')] }, true)
    expect(lib.positions.map(p => p.id)).toEqual(['e', 'd'])
  })
})
