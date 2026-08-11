/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// Composition test: the chess grammar plugin layered with the official
// @tabnas/debug plugin. @tabnas/debug is a devDependency, but this still
// resolves it dynamically and SKIPS when it is absent so the suite stays
// runnable outside the package; TABNAS_DEBUG_PATH can point at a sibling
// checkout's built plugin.
//
// It also pins the grammar's shape: the rule set, the entry rule, and the
// push edges that make a variation recursive. Those are the claims
// doc/concepts.md makes about the grammar, checked against the live model
// rather than against the source file.

import { describe, test } from 'node:test'
import assert from 'node:assert'

import { Tabnas } from '@tabnas/parser'
import { Chess } from '../dist/chess'

function loadDebug(): any {
  const candidates = [process.env.TABNAS_DEBUG_PATH, '@tabnas/debug'].filter(
    Boolean,
  ) as string[]
  for (const c of candidates) {
    try {
      return require(c).Debug
    } catch {
      /* try next */
    }
  }
  return null
}

const Debug = loadDebug()
const skip = Debug ? false : '@tabnas/debug not available (set TABNAS_DEBUG_PATH)'

function build(): any {
  const tn = new Tabnas().use(Chess, {})
  tn.use(Debug, { print: false, trace: false })
  return tn
}

// Every rule the debug model reports as pushed or replaced by `name`.
function edges(model: any, name: string): string[] {
  const rule = model.rules.find((r: any) => r.name === name)
  assert.ok(rule, `no rule ${name} in the model`)
  const out = new Set<string>()
  for (const phase of ['open', 'close']) {
    for (const alt of rule[phase] || []) {
      if (alt.push) out.add(alt.push)
      if (alt.replace) out.add(alt.replace)
    }
  }
  return [...out].sort()
}

describe('compose: chess + @tabnas/debug', () => {
  test('parses normally with the debug plugin installed', { skip }, () => {
    const tn = build()
    const game = JSON.parse(JSON.stringify(tn.parse('1. e4 e5 (1... c5) 1-0')))[0]
    assert.equal(game.result, '1-0')
    assert.equal(game.moves.length, 2)
    assert.equal(game.moves[1].variations[0].moves[0].san, 'c5')
  })

  test('debug.model() returns the structured chess grammar', { skip }, () => {
    const tn = build()
    const m = tn.debug.model()

    assert.deepStrictEqual(
      m.rules.map((r: any) => r.name).sort(),
      ['element', 'game', 'gameitem', 'move', 'movetext', 'pgn', 'rav', 'tag', 'tagbody'],
    )
    // Note `config.start`, not `m.start`.
    assert.equal(m.config.start, 'pgn')
    assert.ok(m.plugins.some((p: any) => 'Chess' === (p.name ?? p)))
  })

  test('the push edges make a game, and a variation recursive', { skip }, () => {
    const m = build().debug.model()

    // A database is a sequence of games; `gameitem` iterates by replacing
    // itself, so `pgn`'s node stays put across repetitions.
    assert.deepStrictEqual(edges(m, 'pgn'), ['gameitem'])
    assert.deepStrictEqual(edges(m, 'gameitem'), ['game', 'gameitem'])

    // A game is a tag section then a movetext section.
    assert.deepStrictEqual(edges(m, 'game'), ['movetext', 'tag'])
    assert.deepStrictEqual(edges(m, 'tag'), ['tagbody'])

    // An element sequence iterates, and one of its elements is a variation
    // that re-enters movetext — the recursion of PGN spec 8.2.5.
    assert.deepStrictEqual(edges(m, 'movetext'), ['element'])
    assert.deepStrictEqual(edges(m, 'element'), ['element', 'rav'])
    assert.deepStrictEqual(edges(m, 'rav'), ['movetext'])

    // The alternate entry point stands alone.
    assert.deepStrictEqual(edges(m, 'move'), [])
  })

  test('the model is JSON-serialisable and round-trips', { skip }, () => {
    const m = build().debug.model()
    assert.deepStrictEqual(JSON.parse(JSON.stringify(m)), m)
  })
})
