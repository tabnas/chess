/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// Cases that a `test/spec/*.tsv` fixture cannot express: option handling,
// error messages, the exported helpers, and the plugin's own surface.
// Everything expressible as `input -> JSON` belongs in a fixture instead.

import { describe, test } from 'node:test'
import assert from 'node:assert'

import { Tabnas } from '@tabnas/parser'
import {
  Chess,
  parse,
  parseGame,
  parseSan,
  stripCommands,
  ANNOTATION_NAG,
  VERSION,
} from '../dist/chess'
import type { Game, Move } from '../dist/chess'

function mk(options?: any) {
  return new Tabnas().use(Chess, options)
}

describe('plugin', () => {
  test('exports a version', () => {
    assert.match(VERSION, /^\d+\.\d+\.\d+/)
  })

  test('installs on a bare engine', () => {
    const tn = mk()
    assert.deepStrictEqual(tn.parse('e4')[0].moves[0].san, 'e4')
  })

  test('parse and parseGame are equivalent', () => {
    const src = '1. e4 e5 *'
    assert.deepStrictEqual(parseGame(src), parse(src)[0])
  })

  test('empty source is an empty database', () => {
    assert.deepStrictEqual(parse(''), [])
    assert.deepStrictEqual(parse('   \n\n  '), [])
    assert.strictEqual(parseGame(''), undefined)
  })
})

describe('start rule', () => {
  test('move start rule returns one move', () => {
    const move: Move = mk({ start: 'move' }).parse('Qa6xb7#')
    assert.deepStrictEqual(move, {
      san: 'Qa6xb7#',
      piece: 'Q',
      disambiguation: { file: 'a', rank: 6 },
      capture: true,
      to: 'b7',
      check: '#',
    })
  })

  test('a bare move has no number or side', () => {
    const move: Move = mk({ start: 'move' }).parse('e4')
    assert.strictEqual(move.number, undefined)
    assert.strictEqual(move.side, undefined)
  })

  test('move start rule rejects a move sequence', () => {
    assert.throws(() => mk({ start: 'move' }).parse('e4 e5'))
  })
})

describe('san', () => {
  test('parseSan matches the parser', () => {
    for (const san of ['e4', 'exd5', 'Nbd7', 'O-O', 'e8=Q+', 'Qh4e1']) {
      assert.deepStrictEqual(
        parseSan(san),
        (() => {
          const m = { ...parse(san)[0].moves[0] }
          delete m.number
          delete m.side
          return m
        })(),
        san,
      )
    }
  })

  test('parseSan rejects a non-move', () => {
    assert.strictEqual(parseSan('e9'), undefined)
    assert.strictEqual(parseSan('hello'), undefined)
    assert.strictEqual(parseSan(''), undefined)
    // A prefix match is not a match: the whole string must be the move.
    assert.strictEqual(parseSan('e4e5'), undefined)
  })

  test('a run-together pair of moves is rejected, not split', () => {
    // Without the symbol-tail guard this would silently parse as e2, e4.
    assert.throws(() => parse('e2e4'), /unexpected/)
  })

  test('suffix annotation is split off the san', () => {
    const m = parse('e4!? *')[0].moves[0]
    assert.strictEqual(m.san, 'e4')
    assert.strictEqual(m.annotation, '!?')
  })

  test('ANNOTATION_NAG covers every suffix annotation', () => {
    assert.deepStrictEqual(Object.keys(ANNOTATION_NAG).sort(), [
      '!', '!!', '!?', '?', '?!', '??',
    ])
  })
})

describe('strict mode', () => {
  const lenient = mk()
  const strict = mk({ strict: true })

  const importOnly: [string, string][] = [
    ['0-0', 'zero castling'],
    ['0-0-0', 'zero long castling'],
    ['Pe4', 'pawn letter prefix'],
    ['e8Q', 'promotion without ='],
    ['e4!', 'suffix annotation'],
    ['e4++', 'double check'],
  ]

  for (const [src, why] of importOnly) {
    test(`lenient accepts ${why}: ${src}`, () => {
      assert.strictEqual(parse(src + ' *')[0].moves.length, 1)
    })
    test(`strict rejects ${why}: ${src}`, () => {
      assert.throws(() => strict.parse(src + ' *'), src)
    })
  }

  test('both accept canonical san', () => {
    for (const src of ['e4', 'O-O', 'O-O-O', 'exd5', 'e8=Q', 'Qa6xb7#', 'Nbd7']) {
      assert.strictEqual(lenient.parse(src + ' *')[0].moves.length, 1, src)
      assert.strictEqual(strict.parse(src + ' *')[0].moves.length, 1, src)
    }
  })
})

describe('comments', () => {
  test('commands are parsed by default and text is kept verbatim', () => {
    const m = parse('1. e4 { good [%clk 0:05:00] [%cal Ra1a8,Gb1b8] } *')[0].moves[0]
    assert.deepStrictEqual(m.comments, [
      {
        kind: 'brace',
        text: ' good [%clk 0:05:00] [%cal Ra1a8,Gb1b8] ',
        commands: [
          { name: 'clk', args: ['0:05:00'] },
          { name: 'cal', args: ['Ra1a8', 'Gb1b8'] },
        ],
      },
    ])
  })

  test('commands can be switched off', () => {
    const m = mk({ commands: false }).parse('1. e4 {[%clk 0:05:00]} *')[0].moves[0]
    assert.deepStrictEqual(m.comments, [{ kind: 'brace', text: '[%clk 0:05:00]' }])
  })

  test('stripCommands removes the markup', () => {
    assert.strictEqual(stripCommands(' good [%clk 0:05:00] move '), 'good move')
    assert.strictEqual(stripCommands('no markup'), 'no markup')
  })

  test('an unterminated brace comment is an error', () => {
    assert.throws(() => parse('1. e4 { never closed'), /unterminated/)
  })

  test('a brace comment may span lines and keeps later positions honest', () => {
    const game = parseGame('1. e4 {line one\nline two} e5 *') as Game
    assert.strictEqual(game.moves[0].comments?.[0].text, 'line one\nline two')
    assert.throws(
      () => parse('1. e4 {line one\nline two}\nzz'),
      (err: Error) => err.message.includes('3:1'),
    )
  })
})

describe('escape mechanism', () => {
  test('a first-column % escapes the line', () => {
    const game = parseGame('%private data\n1. e4 e5 *') as Game
    assert.strictEqual(game.moves.length, 2)
  })

  test('a % elsewhere is not an escape', () => {
    assert.throws(() => parse('1. e4 %private\n'), /unexpected/)
  })
})

describe('tag pairs', () => {
  test('a repeated tag name keeps the first value', () => {
    const game = parseGame('[Event "one"]\n[Event "two"]\n*') as Game
    assert.strictEqual(game.tags.Event, 'one')
  })

  test('quote and backslash escapes', () => {
    const game = parseGame('[Note "a \\"quoted\\" \\\\ word"]\n*') as Game
    assert.strictEqual(game.tags.Note, 'a "quoted" \\ word')
  })

  test('a tag value may be empty', () => {
    assert.strictEqual((parseGame('[Event ""]\n*') as Game).tags.Event, '')
  })

  test('a malformed tag pair is an error', () => {
    assert.throws(() => parse('[Event]\n*'))
    assert.throws(() => parse('[Event "x"\n*'))
    assert.throws(() => parse('["x" Event]\n*'))
  })

  test('prototype-polluting tag names are refused', () => {
    const game = parseGame('[__proto__ "x"]\n*') as Game
    assert.notStrictEqual(({} as any).x, 'x')
    assert.ok(game)
  })
})

describe('move numbering', () => {
  test('numbering is counted when unstated', () => {
    const moves = (parseGame('e4 e5 Nf3 Nc6 *') as Game).moves
    assert.deepStrictEqual(
      moves.map((m) => `${m.number}${'w' === m.side ? '.' : '...'}`),
      ['1.', '1...', '2.', '2...'],
    )
  })

  test('a stated number resynchronises the count', () => {
    const moves = (parseGame('1. e4 e5 15. Nf3 *') as Game).moves
    assert.deepStrictEqual(moves.map((m) => m.number), [1, 1, 15])
  })

  test('three dots mean Black to move', () => {
    const moves = (parseGame('4... e5 5. Nf3 *') as Game).moves
    assert.deepStrictEqual(moves.map((m) => m.side), ['b', 'w'])
  })

  test('a FEN tag sets the starting number and side', () => {
    const game = parseGame(
      '[FEN "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 12"]\ne5 Nf3 *',
    ) as Game
    assert.deepStrictEqual(
      game.moves.map((m) => [m.number, m.side]),
      [[12, 'b'], [13, 'w']],
    )
  })

  test('a malformed FEN tag falls back to move 1, White', () => {
    const game = parseGame('[FEN "nonsense"]\ne4 *') as Game
    assert.deepStrictEqual([game.moves[0].number, game.moves[0].side], [1, 'w'])
  })

  test('a variation starts on the move it replaces', () => {
    const game = parseGame('1. e4 e5 (1... c5 2. Nf3) 2. Nf3 *') as Game
    const variation = game.moves[1].variations?.[0]
    assert.deepStrictEqual(
      variation?.moves.map((m) => [m.number, m.side]),
      [[1, 'b'], [2, 'w']],
    )
  })
})

describe('errors', () => {
  test('an illegal square is rejected', () => {
    assert.throws(() => parse('1. e9 *'), /unexpected/)
    assert.throws(() => parse('1. Zf3 *'), /unexpected/)
  })

  test('an unclosed variation is rejected', () => {
    assert.throws(() => parse('1. e4 (1. d4 *'))
  })

  test('a stray close paren is rejected', () => {
    assert.throws(() => parse('1. e4) *'))
  })

  test('the error names the row and column', () => {
    assert.throws(
      () => parse('[Event "x"]\n\n1. e4 zz'),
      (err: Error) => err.message.includes('3:7'),
    )
  })
})
