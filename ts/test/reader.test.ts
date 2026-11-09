/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// A parse from a reader (`tn.parseReader`, admin ADR-30). `make` declares
// `lex.window`, so a database is read a window of the source at a time,
// and the plugin's matchers read the text only through the window, each
// filling it as far as it reads (src/chess.ts, "Reading through the
// window"). Every row of the shared fixtures parses the same from a reader
// as from its text, handed over in pieces of 1, 3 and 64 bytes, under the
// fixed window and under windows of a few units, so that every matcher
// meets the window's edge: the same value, tokens and rule passes, and an
// error's code, position, row and column. So does a long database whose
// tokens of every kind straddle the 64 KiB boundaries, its comments,
// remarks, escapes, tag values, tag names and move numbers longer than a
// window included. `rs/tests/reader_test.rs` and `go/reader_test.go` are
// its twins.

import { describe, test } from 'node:test'
import assert from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { Tabnas } from '@tabnas/parser'
import { Chess, make } from '../dist/chess'

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

type Row = { at: string; input: string; opts: any }

function rows(): Row[] {
  const out: Row[] = []
  for (const file of readdirSync(specDir).filter((f) => f.endsWith('.tsv')).sort()) {
    const lines = readFileSync(join(specDir, file), 'utf8').split(/\r?\n/)
    for (let i = 1; i < lines.length; i++) {
      const raw = lines[i]
      if (raw === '' || (raw.startsWith('#') && !raw.includes('\t'))) continue
      const cols = raw.split('\t')
      const opts = '' === (cols[2] ?? '').trim() ? {} : JSON.parse(cols[2])
      out.push({ at: `${file}:${i + 1}`, input: unescape(cols[0]), opts })
    }
  }
  return out
}

// A reader that hands its bytes over at most `size` at a time.
function pieces(bytes: Uint8Array, size: number) {
  let at = 0
  return {
    read(buf: Uint8Array): number {
      const n = Math.min(size, buf.length, bytes.length - at)
      buf.set(bytes.subarray(at, at + n))
      at += n
      return n
    },
  }
}

type Span = [string, number, number]
type Log = { tokens: string[]; rules: string[]; spans: Span[] }

const newLog = (): Log => ({ tokens: [], rules: [], spans: [] })

// `tn`, recording the tokens and rule passes of each parse into `log`, and
// each token's name, position and length.
function recorded(tn: Tabnas, log: Log): Tabnas {
  tn.sub({
    lex: (tkn: any) => {
      const src: string = tkn.src
      log.tokens.push(
        tkn.name + ' ' + JSON.stringify(src) + ' ' + JSON.stringify(tkn.val) +
          ' ' + tkn.sI + ' ' + tkn.rI + ':' + tkn.cI,
      )
      log.spans.push([tkn.name, tkn.sI, src.length])
    },
    ruleDone: (rule: any, _ctx: any, done: any) => {
      log.rules.push(rule.name + ' ' + done.state)
    },
  })
  return tn
}

type Seen = { outcome: string; tokens: string[]; rules: string[]; spans: Span[] }

// What a parse showed: its value, or its error's code, position, row,
// column and token (not its excerpt, which a window may cut); and its
// tokens and passes, taken from `log`, which is empty again after.
function seen(log: Log, parse: () => any): Seen {
  let outcome: string
  try {
    outcome = 'ok ' + JSON.stringify(parse())
  } catch (e: any) {
    if ('function' !== typeof e?.toJSON) throw e
    const d = e.toJSON()
    outcome =
      `err ${d.code} at ${d.pos} ${d.row}:${d.col} ` +
      `${d.token.name} ${JSON.stringify(d.token.src)}`
  }
  const { tokens, rules, spans } = log
  log.tokens = []
  log.rules = []
  log.spans = []
  return { outcome, tokens, rules, spans }
}

const utf8 = (text: string) => Buffer.from(text, 'utf8')

// Windows whose margin and block are a few units, so that every matcher
// meets the window's edge, and the fixed window (`undefined`).
const WINDOWS: ([number, number] | undefined)[] = [undefined, [1, 1], [3, 2], [64, 64]]

describe('a parse from a reader', () => {
  test('make declares the window, and the plugin leaves it to its caller', () => {
    assert.equal(make().config().lex.window, true)
    assert.equal(make({ start: 'move', strict: true }).config().lex.window, true)
    assert.notEqual(new Tabnas().use(Chess).config().lex.window, true)
  })

  test('every fixture row parses the same from a reader', () => {
    let compared = 0
    for (const row of rows()) {
      const log = newLog()
      const tn = recorded(make(row.opts), log)
      const whole = seen(log, () => tn.parse(row.input))
      const bytes = utf8(row.input)
      for (const size of [1, 3, 64]) {
        for (const window of WINDOWS) {
          const read = seen(log, () =>
            undefined === window
              ? tn.parseReader(pieces(bytes, size))
              : tn.parseReaderWithSizes(pieces(bytes, size), {
                  margin: window[0],
                  block: window[1],
                  chunk: size,
                }),
          )
          const at = `${row.at} in pieces of ${size}, window ${window ?? 'fixed'}`
          assert.equal(read.outcome, whole.outcome, at)
          assert.deepStrictEqual(read.tokens, whole.tokens, at)
          assert.deepStrictEqual(read.rules, whole.rules, at)
          compared++
        }
      }
    }
    assert.ok(3000 < compared, `${compared}`)
  })

  test('a long database parses the same from a reader', () => {
    const text = longDatabase()
    const log = newLog()
    const tn = recorded(make(), log)
    const whole = seen(log, () => tn.parse(text))
    assert.ok(whole.outcome.startsWith('ok '), whole.outcome.slice(0, 200))
    assert.ok(64 < JSON.parse(whole.outcome.slice(3)).length)
    straddles(text, whole.spans)

    const bytes = utf8(text)
    for (const [size, window] of [
      [4096, undefined],
      [65536, undefined],
      [7, [16, 16]],
    ] as [number, [number, number] | undefined][]) {
      const read = seen(log, () =>
        undefined === window
          ? tn.parseReader(pieces(bytes, size))
          : tn.parseReaderWithSizes(pieces(bytes, size), {
              margin: window[0],
              block: window[1],
              chunk: size,
            }),
      )
      const at = `in pieces of ${size}, window ${window ?? 'fixed'}`
      assert.equal(read.outcome, whole.outcome, at)
      assert.equal(read.tokens.length, whole.tokens.length, at)
      assert.deepStrictEqual(read.tokens, whole.tokens, at)
      assert.deepStrictEqual(read.rules, whole.rules, at)
    }
  })

  test('a comment left open at the end of a long database fails where its text does', () => {
    const text = longDatabase() + '1. e4 {never closed ' + line(LONG)
    const tn = make()
    const log = newLog()
    const whole = seen(log, () => tn.parse(text))
    assert.ok(whole.outcome.startsWith('err unterminated_comment at '), whole.outcome.slice(0, 80))
    for (const size of [4096, 65536]) {
      const read = seen(log, () => tn.parseReader(pieces(utf8(text), size)))
      assert.equal(read.outcome, whole.outcome, `in pieces of ${size}`)
    }
  })
})

// --- A long database ------------------------------------------------------

// The window's fixed margin and block, in UTF-16 units.
const BOUNDARY = 64 * 1024

// Longer than a window.
const LONG = 70_000

// A game of the kind a database is mostly made of: tag pairs, comments
// with markup, a glyph, a variation, a rest-of-line comment, an escape and
// a termination marker, with characters past ASCII among them.
function filler(i: number): string {
  return (
    `[Event "Filler ${i} ñ"]\n[Site "Göteborg ♞"]\n[Round "${i}"]\n[Result "1-0"]\n\n` +
    `1. e4 e5 2. Nf3 {[%clk 0:03:00] the main line 𝄞} Nc6 $1 (2... d6 3. d4 exd4) ` +
    `3. Bb5 a6 ; a remark é\n% private data\n4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 ` +
    `7. Bb3 d6 8. c3 O-O 9. h3 Na5 10. Bc2 c5 11. d4 Qc7 12. Nbd2 cxd4 1-0\n\n`
  )
}

// Games that each hold a token of one kind at a known place in their text:
// the token's name, the game, and where the token starts in it.
const PROBES: [string, string, number][] = [
  ['#TGN', '[WhiteElo "2700"]\n\n1. d4 d5 1-0\n\n', 1],
  ['#ST', '[Event "Probe ñ"]\n\n1. d4 d5 1-0\n\n', 7],
  ['#MVN', '12... Nf6 13. Nbd2 *\n\n', 0],
  ['#SAN', '1. Nbxd2+ e5 *\n\n', 3],
  ['#NAG', '1. e4 $123 e5 *\n\n', 6],
  ['#RES', '1. e4 e5 1/2-1/2\n\n', 9],
  ['#CMT', '1. e4 {a comment ñ\nover two lines} e5 *\n\n', 6],
  ['#RMK', '1. e4 ; a remark ñ\ne5 *\n\n', 6],
  ['#CM', '% an escape line\n1. e4 e5 *\n\n', 0],
  ['#SP', '1. e4      e5 *\n\n', 5],
  ['#LN', '1. e4\r\ne5 *\r\n\r\n', 5],
]

// Text of about `n` units with no line break, quote or backslash in it.
function line(n: number): string {
  return 'a long line ñ ♞ 𝄞 '.repeat(Math.ceil(n / 19)).slice(0, n)
}

// Text of about `n` units with line breaks and comment markup in it, and
// no closing brace.
function prose(n: number): string {
  return 'a long comment [%clk 0:01:00] ñ 𝄞\nover lines '.repeat(Math.ceil(n / 45)).slice(0, n)
}

// Games each holding a token longer than a window: a brace comment, a
// rest-of-line comment, an escape, a tag value, a tag name, and a move
// number whose periods follow a run of spaces (PGN spec 8.2.2.1 lets
// space come between the digits and the periods). The last is the one
// place a gated pattern reads past the fixed window's margin.
function longGames(): string[] {
  return [
    `1. e4 {${prose(LONG)}} e5 *\n\n`,
    `1. e4 ;${line(LONG)}\ne5 *\n\n`,
    `%${line(LONG)}\n1. e4 e5 *\n\n`,
    `[Annotator "${line(LONG)}"]\n[${'T'.repeat(LONG)} "x"]\n\n1. e4 e5 *\n\n`,
    `1. e4 e5 2${' '.repeat(LONG)}. Nf3 Nc6 *\n\n`,
  ]
}

// A database of filler games with each probe placed so that its token
// starts one unit before a 64 KiB boundary, and so straddles it, followed
// by the games whose tokens are longer than a window.
function longDatabase(): string {
  let doc = ''
  let n = 0
  for (const [, game, at] of PROBES) {
    let boundary = (Math.floor(doc.length / BOUNDARY) + 1) * BOUNDARY
    if (boundary - 1 - at < doc.length) boundary += BOUNDARY
    while (doc.length + filler(n).length + at + 1 < boundary) doc += filler(n++)
    doc += '\n'.repeat(boundary - 1 - at - doc.length) + game
  }
  return doc + longGames().join('')
}

// Every probe's token straddles a 64 KiB boundary, and every long game's
// token is longer than a window, among the tokens of the whole parse.
function straddles(text: string, spans: Span[]): void {
  for (const [name] of PROBES) {
    assert.ok(
      spans.some(
        ([kind, sI, len]) =>
          kind === name && Math.floor(sI / BOUNDARY) < Math.floor((sI + len - 1) / BOUNDARY),
      ),
      `no ${name} straddles a 64 KiB boundary`,
    )
  }
  for (const name of ['#CMT', '#RMK', '#CM', '#ST', '#TGN', '#MVN']) {
    assert.ok(
      spans.some(([kind, , len]) => kind === name && BOUNDARY < len),
      `no ${name} is longer than a window`,
    )
  }
  assert.ok(8 * BOUNDARY < text.length, `${text.length}`)
}
