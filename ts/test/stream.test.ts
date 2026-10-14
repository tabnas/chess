/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// A database is read a game at a time.
//
// A streaming host follows a parse through its rule nodes:
// tabnas-transduce's rule-event adapter streams a container that is a
// rule's node as the rules close, and walks one that arrives complete. So
// a database streams a game at a time exactly when it is the only
// container any rule holds, and a game joins it only once the game is
// complete. These tests hold the plugin to both, over every fixture that
// reads as a database and over a database of many games, without depending
// on the adapter. `rs/tests/stream_test.rs` is the Rust twin.

import { describe, test } from 'node:test'
import assert from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { Tabnas } from '@tabnas/parser'
import { Chess } from '../dist/chess'

// At runtime this file is loaded from `dist-test/`, so hop up one level to
// reach the shared spec directory in the repo root.
const specDir = join(__dirname, '..', '..', 'test', 'spec')

// Decode the escape set of a fixture column, as parity.test.ts does.
function unescape(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\' && i + 1 < s.length) {
      const n = s[i + 1]
      if (n === 'n') { out += '\n'; i++; continue }
      if (n === 'r') { out += '\r'; i++; continue }
      if (n === 't') { out += '\t'; i++; continue }
      if (n === '\\') { out += '\\'; i++; continue }
    }
    out += c
  }
  return out
}

function fixtureInputs(): [string, string][] {
  const inputs: [string, string][] = []
  for (const file of readdirSync(specDir).filter((f) => f.endsWith('.tsv')).sort()) {
    const lines = readFileSync(join(specDir, file), 'utf8').split(/\r?\n/)
    for (let i = 1; i < lines.length; i++) {
      const raw = lines[i]
      if (raw === '' || (raw.startsWith('#') && !raw.includes('\t'))) continue
      inputs.push([`${file}:${i + 1}`, unescape(raw.split('\t')[0])])
    }
  }
  return inputs
}

type Seen = { database?: any; others: string[]; joined: string[] }

// Parse `src` as a database, watching every rule pass. `undefined` when
// the text is not one.
function watch(src: string): { seen: Seen; value: any } | undefined {
  const seen: Seen = { others: [], joined: [] }
  const tn = new Tabnas().use(Chess)
  tn.sub({
    ruleDone: (rule: any) => {
      const node = rule.node
      if (null == node || 'object' !== typeof node) return
      if (undefined === seen.database) {
        seen.database = node
      } else if (seen.database === node) {
        while (seen.joined.length < node.length) {
          seen.joined.push(JSON.stringify(node[seen.joined.length]))
        }
      } else {
        seen.others.push(`${rule.name} held a container of its own`)
      }
    },
  })
  let value: any
  try {
    value = tn.parse(src)
  } catch {
    return undefined
  }
  return { seen, value }
}

function streams(name: string, src: string): boolean {
  const watched = watch(src)
  if (undefined === watched) return false
  const { seen, value } = watched
  assert.deepStrictEqual(seen.others, [], `${name}: the database is not the only container`)
  assert.deepStrictEqual(
    seen.joined,
    value.map((game: any) => JSON.stringify(game)),
    `${name}: a game changed after it joined the database`,
  )
  return true
}

describe('a database streams a game at a time', () => {
  test('every fixture that reads as a database', () => {
    const inputs = fixtureInputs()
    let read = 0
    for (const [name, input] of inputs) {
      if (streams(name, input)) read++
    }
    // A floor, so that a loader that read nothing cannot pass: 197 of the
    // fixtures' inputs read as databases when this test was written.
    assert.ok(150 <= read, `only ${read} of ${inputs.length} inputs read as databases`)
  })

  test('a database of many games', () => {
    // Every shape a game's tree can take while it is built: tags, a FEN
    // start, numbers, nags, both kinds of comment with commands, nested
    // variations, a variation before the first move, every result, and a
    // game the next one's tags end.
    const games = [
      '[Event "a"]\n[Site "b"]\n\n1. e4 e5 2. Nf3 {main} Nc6 $1 (2... d6 3. d4 (3. Bc4 $2) exd4) 3. Bb5 1-0',
      '[FEN "8/8/8/8/8/8/8/8 b - - 0 12"]\n\n12... e5 13. Nf3 {[%clk 0:01:00]} ; rest of line\n0-1',
      '{before} (1. d4) 1. e4 $14 {after} 1/2-1/2',
      '[Event "no result"]\n\n1. c4 c5',
      '[Event "star"]\n\n1. a3 *',
    ]
    let src = ''
    for (let round = 0; round < 200; round++) {
      src += games[round % games.length] + '\n\n'
    }
    assert.ok(streams('many', src), 'the database reads')
    assert.strictEqual(200, watch(src)!.seen.joined.length)
  })
})
