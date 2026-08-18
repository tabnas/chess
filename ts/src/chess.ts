/* Copyright (c) 2026 Richard Rodger, MIT License */

/* @tabnas/chess — a Tabnas grammar plugin for chess notation.
 *
 * Parses PGN (Portable Game Notation) and the SAN (Standard Algebraic
 * Notation) moves inside it, and returns a plain, JSON-serialisable game
 * model. See doc/concepts.md for why the model looks the way it does.
 *
 * This is a grammar plugin on the bare engine (like @tabnas/json), not a
 * jsonic extension: chess notation is not JSON-shaped, so there is no
 * relaxed-JSON behaviour worth inheriting.
 */

import { Tabnas } from '@tabnas/parser'
import type { Context, FuncRef, Plugin, Rule, Token } from '@tabnas/parser'

// --- BEGIN EMBEDDED chess-grammar.jsonic ---
const grammarText = `
{
  "rule": {
    "pgn": {
      "open": [
        {
          "s": "#ZZ",
          "g": "pgn,empty"
        },
        {
          "s": "#HEAD",
          "p": "gameitem",
          "b": 1,
          "g": "pgn,game"
        }
      ],
      "close": [
        {
          "s": "#ZZ",
          "g": "pgn,end"
        }
      ]
    },
    "gameitem": {
      "open": [
        {
          "s": "#HEAD",
          "p": "game",
          "b": 1,
          "g": "game,item"
        }
      ],
      "close": [
        {
          "s": "#HEAD",
          "r": "gameitem",
          "b": 1,
          "g": "game,next"
        },
        {
          "s": "#ZZ",
          "g": "game,end"
        }
      ]
    },
    "game": {
      "open": [
        {
          "s": "#OS",
          "p": "tag",
          "b": 1,
          "g": "game,tag"
        },
        {
          "s": "#ELEM",
          "p": "movetext",
          "b": 1,
          "g": "game,movetext"
        },
        {
          "s": "#RES",
          "a": "@result-open",
          "g": "game,result"
        }
      ],
      "close": [
        {
          "s": "#OS",
          "p": "tag",
          "b": 1,
          "c": "@more-tags",
          "g": "game,tag"
        },
        {
          "s": "#ELEM",
          "p": "movetext",
          "b": 1,
          "c": "@no-result",
          "g": "game,movetext"
        },
        {
          "s": "#RES",
          "a": "@result-close",
          "g": "game,result"
        },
        {
          "s": "#ZZ",
          "g": "game,end"
        },
        {
          "b": 1,
          "g": "game,more"
        }
      ]
    },
    "tag": {
      "open": [
        {
          "s": "#OS",
          "p": "tagbody",
          "g": "tag,open"
        }
      ],
      "close": [
        {
          "s": "#CS",
          "g": "tag,close"
        }
      ]
    },
    "tagbody": {
      "open": [
        {
          "s": "#TGN #ST",
          "a": "@tag",
          "g": "tag,pair"
        }
      ],
      "close": [
        {
          "s": "#CS",
          "b": 1,
          "g": "tag,end"
        }
      ]
    },
    "movetext": {
      "open": [
        {
          "s": "#ELEM",
          "p": "element",
          "b": 1,
          "g": "movetext,elem"
        }
      ],
      "close": [
        {
          "s": "#EEND",
          "b": 1,
          "g": "movetext,end"
        },
        {
          "s": "#ZZ",
          "g": "movetext,end"
        },
        {
          "b": 1,
          "g": "movetext,more"
        }
      ]
    },
    "element": {
      "open": [
        {
          "s": "#SAN",
          "a": "@move",
          "g": "elem,move"
        },
        {
          "s": "#MVN",
          "a": "@number",
          "g": "elem,number"
        },
        {
          "s": "#NAG",
          "a": "@nag",
          "g": "elem,nag"
        },
        {
          "s": "#CMT",
          "a": "@brace-comment",
          "g": "elem,comment"
        },
        {
          "s": "#RMK",
          "a": "@line-comment",
          "g": "elem,comment"
        },
        {
          "s": "#OP",
          "p": "rav",
          "b": 1,
          "u": {
            "rav": true
          },
          "g": "elem,rav"
        }
      ],
      "close": [
        {
          "s": "#ELEM",
          "r": "element",
          "b": 1,
          "g": "elem,next"
        },
        {
          "s": "#EEND",
          "b": 1,
          "g": "elem,end"
        },
        {
          "s": "#ZZ",
          "g": "elem,end"
        },
        {
          "b": 1,
          "g": "elem,more"
        }
      ]
    },
    "rav": {
      "open": [
        {
          "s": "#OP",
          "p": "movetext",
          "g": "rav,open"
        }
      ],
      "close": [
        {
          "s": "#CP",
          "g": "rav,close"
        }
      ]
    },
    "move": {
      "open": [
        {
          "s": "#SAN",
          "a": "@bare-move",
          "g": "move,san"
        }
      ],
      "close": [
        {
          "s": "#ZZ",
          "g": "move,end"
        },
        {
          "b": 1,
          "g": "move,more"
        }
      ]
    }
  }
}`
// --- END EMBEDDED chess-grammar.jsonic ---

export const VERSION = '0.1.5'

// --- The parse model -----------------------------------------------------

/** Side to move. `w` is White, `b` is Black. */
export type Side = 'w' | 'b'

/** A piece letter, PGN spec 8.2.3.2. Pawns are `P` even when unwritten. */
export type Piece = 'P' | 'N' | 'B' | 'R' | 'Q' | 'K'

/** The four pieces a pawn may promote to, PGN spec 8.2.3.3. */
export type PromotionPiece = 'N' | 'B' | 'R' | 'Q'

/** Which side of the board a castling move is on. */
export type CastleSide = 'king' | 'queen'

/** Check (`+`) or checkmate (`#`) indicator, PGN spec 8.2.3.5. */
export type CheckIndicator = '+' | '#'

/** Traditional move suffix annotation, PGN spec 8.2.3.8. */
export type Annotation = '!' | '?' | '!!' | '??' | '!?' | '?!'

/** Game termination marker, PGN spec 8.2.6. */
export type GameResult = '1-0' | '0-1' | '1/2-1/2' | '*'

/**
 * As much of a move's origin square as the notation states, PGN spec
 * 8.2.3.4. Never inferred: a parser without a board cannot know the
 * origin of `Nf3`, so `disambiguation` is absent unless it was written.
 */
export interface Disambiguation {
  file?: string
  rank?: number
}

/**
 * One `[%name operand,operand]` command inside a comment.
 *
 * Not from the 1994 standard — from the *PGN Specification Supplement*
 * (Cowderoy, Bulsink, Templeton, Bentzen, Feist and Zakharov; final draft
 * 8 September 2001), which defines the syntax and four time commands:
 * `clk`, `egt`, `emt` and `mct`. The `eval`, `csl` and `cal` commands seen
 * in lichess and ChessBase exports use the same syntax without being part
 * of it, so this parses the syntax and interprets none of the names.
 */
export interface Command {
  name: string
  /** Operands in order. A quoted operand keeps its content, not its quotes. */
  args: string[]
}

/** A comment, PGN spec 5. `text` is the body verbatim, markup included. */
export interface Comment {
  kind: 'brace' | 'line'
  text: string
  commands?: Command[]
}

/** One move, as written. Fields absent from the notation are absent here. */
export interface Move {
  /** The move as written, without any suffix annotation. */
  san: string
  piece: Piece
  disambiguation?: Disambiguation
  capture?: boolean
  /** Destination square, e.g. `e4`. Absent for castling. */
  to?: string
  promotion?: PromotionPiece
  castle?: CastleSide
  check?: CheckIndicator
  annotation?: Annotation
  /** Fullmove number: stated by a move number indication, else counted. */
  number?: number
  /** Side to move: implied by the count, or by a `...` indication. */
  side?: Side
  nags?: number[]
  comments?: Comment[]
  variations?: Line[]
}

/**
 * A move sequence: a game's mainline, or one variation.
 *
 * An annotation belongs to the move it follows. `comments`, `nags` and
 * `variations` here hold the ones that precede the line's first move and
 * so have no move to belong to — they annotate the starting position.
 */
export interface Line {
  moves: Move[]
  comments?: Comment[]
  nags?: number[]
  variations?: Line[]
}

/** One game: a tag pair section plus a movetext section, PGN spec 8. */
export interface Game extends Line {
  tags: Record<string, string>
  result?: GameResult
}

/** A PGN database is a sequence of games, PGN spec 18. */
export type Database = Game[]

export interface ChessOptions {
  /**
   * Require export-format SAN (PGN spec 8.2.3.7): castling only as
   * `O-O`/`O-O-O`, no `P` pawn prefix, `=` before a promotion piece, and
   * no `!`/`?` suffix annotations. Default `false` (import format).
   */
  strict?: boolean

  /**
   * Parse `[%name arg,arg]` markup inside comments into `Comment.commands`.
   * The comment text is kept verbatim either way. Default `true`.
   */
  commands?: boolean

  /**
   * Which rule to parse from, and so what `parse` returns:
   *
   * - `pgn` (default) — a whole database, returning `Game[]`
   * - `game` — one game, returning `Game`
   * - `movetext` — an element sequence with no tag section
   * - `move` — a single SAN move, returning `Move`
   */
  start?: 'pgn' | 'game' | 'movetext' | 'move'
}

// --- Lexical definitions -------------------------------------------------

// PGN spec 7: a symbol token continues through these characters, so a
// token that ends immediately before one of them has not really ended.
// Without this guard `e2e4` would lex as the two moves `e2` and `e4`.
const SYMBOL_TAIL = '(?![A-Za-z0-9_+#=:-])'

// One SAN move, decomposed into the PGN spec's own vocabulary. The same
// regular expression lexes the token and takes it apart, so the two can
// never drift.
function sanPattern(strict: boolean): RegExp {
  const castle = strict ? 'O-O-O|O-O' : 'O-O-O|O-O|0-0-0|0-0'
  const piece = strict ? '[KQRBN]' : '[KQRBNP]'
  const promote = strict ? '=' : '=?'
  const check = strict ? '[+#]' : '\\+\\+|[+#]'
  const annotation = strict ? '' : '(?<annotation>!!|\\?\\?|!\\?|\\?!|!|\\?)?'
  return new RegExp(
    '^(?:' +
    `(?<castle>${castle})` +
    // Piece move: letter, optional disambiguation, optional capture, target.
    `|(?<piece>${piece})(?<dfile>[a-h])?(?<drank>[1-8])?(?<pcapture>x)?` +
    '(?<pto>[a-h][1-8])' +
    // Pawn move: origin file, optional capture, target rank, promotion.
    '|(?<pfile>[a-h])(?:x(?<pxfile>[a-h]))?(?<prank>[1-8])' +
    `(?:${promote}(?<promotion>[QRBN]))?` +
    ')' +
    `(?<check>${check})?` +
    annotation +
    SYMBOL_TAIL,
  )
}

// Move number indication, PGN spec 8.2.2: digits, then zero or more
// periods, with optional space between.
//
// Two guards. A number written WITHOUT periods must still end its symbol
// token (spec 7), or `12e4` would lex as move number 12 plus the move e4
// rather than as the one bad token it is — and that also keeps the `1` of
// a `1-0` or `1/2-1/2` termination marker out. And the number starts at 1:
// the indication gives "the move number of the immediately following white
// move" (8.2.2), and there is no move zero. Nine digits is far past any
// real game and stops an absurd literal reaching the number parser.
const MOVE_NUMBER = /^[1-9]\d{0,8}(?:[ \t]*\.+|(?![A-Za-z0-9_+#=:/-]))/

// Numeric annotation glyph, PGN spec 8.2.4. The value must be 0..255;
// import format is not fussy about that, export format is.
const NAG = /^\$\d{1,9}/
const NAG_STRICT = /^\$(?:25[0-5]|2[0-4]\d|1\d\d|\d\d?)(?!\d)/

// Game termination marker, PGN spec 8.2.6. Three of the four are symbol
// tokens and so must end at a non-symbol character; the asterisk "is a
// token by itself... It is self terminating" (spec 7), which is what lets
// `*1. e4` close one game and open the next.
const RESULT = /^(?:(?:1-0|0-1|1\/2-1\/2)(?![A-Za-z0-9_+#=:/-])|\*)/

// Tag name, PGN spec 8.1: letters, digits and underscore only.
const TAG_NAME = /^[A-Za-z0-9_]+/

// The opening of a `[%name …]` command inside a comment. Only the opening:
// where it ENDS cannot be written as a regular expression — see scanCommands.
const COMMAND_OPEN = /\[%([A-Za-z_][A-Za-z0-9_]*)/g

const SUFFIX = /(?:!!|\?\?|!\?|\?!|!|\?)$/

/**
 * The NAG each traditional suffix annotation maps to, PGN spec 8.2.3.8
 * and 10. Exported so callers can normalise import-format annotations the
 * way an export-format writer would.
 */
export const ANNOTATION_NAG: Record<Annotation, number> = {
  '!': 1,
  '?': 2,
  '!!': 3,
  '??': 4,
  '!?': 5,
  '?!': 6,
}

/**
 * Find every `[%name operand,operand]` command in a comment body.
 *
 * A scanner rather than a regular expression, because the supplement puts
 * the terminator inside the operand grammar: an operand is either bare —
 * any ASCII but a comma or a right bracket — or a double-quoted string,
 * which may contain both. So in
 *
 *     [%src "Lasker, Common Sense in Chess (1896), p. 12]"]
 *
 * the command ends at the last bracket, and holds one operand, not two.
 * `[^\]]*` would stop at the first bracket and split the citation at its
 * comma; no regular expression can do better, because matching quotes is
 * not something a regular language can express.
 *
 * Anything that does not close is not a command: it stays in `text` as the
 * prose it is. The supplement is explicit that a reader which does not
 * understand a command passes it through untouched, and the same courtesy
 * is owed to something that only looks like one.
 *
 * Returns the commands and their spans in `text`, so that stripping them
 * for display removes exactly what parsing them consumed.
 */
function scanCommands(text: string): { commands: Command[]; spans: [number, number][] } {
  const commands: Command[] = []
  const spans: [number, number][] = []

  COMMAND_OPEN.lastIndex = 0
  let open: RegExpExecArray | null
  while (null != (open = COMMAND_OPEN.exec(text))) {
    const start = open.index
    let at = open.index + open[0].length
    const args: string[] = []

    // The name is terminated by the first space — or by the bracket, for a
    // command with no operands at all.
    if (' ' === text[at] || '\t' === text[at]) {
      while (' ' === text[at] || '\t' === text[at]) at++

      for (; ;) {
        if ('"' === text[at]) {
          const close = text.indexOf('"', at + 1)
          if (0 > close) break // unterminated: not a command
          args.push(text.slice(at + 1, close))
          at = close + 1
          // Only a comma or the terminator may follow a quoted operand.
          while (' ' === text[at] || '\t' === text[at]) at++
        } else {
          let end = at
          while (end < text.length && ',' !== text[end] && ']' !== text[end]) end++
          const bare = text.slice(at, end).trim()
          // `a,,b` and a trailing comma contribute nothing, as before.
          if ('' !== bare) args.push(bare)
          at = end
        }

        if (',' === text[at]) {
          at++
          while (' ' === text[at] || '\t' === text[at]) at++
          continue
        }
        break
      }
    }

    if (']' !== text[at]) continue // never closed: leave it as prose
    at++

    commands.push({ name: open[1], args })
    spans.push([start, at])
    COMMAND_OPEN.lastIndex = at
  }

  return { commands, spans }
}

/**
 * Remove `[%name ...]` markup from a comment body and tidy the result.
 *
 * The supplement asks presentation software to "strip out all commands
 * before display in order to improve legibility" — without it, a lichess
 * export reads `{ [%clk 0:03:00] }` where the annotator's prose should be.
 */
export function stripCommands(text: string): string {
  const { spans } = scanCommands(text)
  let out = ''
  let at = 0
  for (const [start, end] of spans) {
    out += text.slice(at, start) + ' '
    at = end
  }
  out += text.slice(at)
  return out.replace(/[ \t]+/g, ' ').trim()
}

/**
 * Take a SAN move string apart. Returns `undefined` if the string is not a
 * SAN move. Exported for callers that hold a move string already.
 */
export function parseSan(src: string, options?: Pick<ChessOptions, 'strict'>): Move | undefined {
  const re = sanPattern(true === options?.strict)
  const m = re.exec(src)
  if (null == m || m[0].length !== src.length) return undefined
  return buildMove(m)
}

function buildMove(m: RegExpExecArray): Move {
  const g: Record<string, string | undefined> = m.groups as any
  const move = { san: m[0].replace(SUFFIX, '') } as Move

  if (null != g.castle) {
    move.piece = 'K'
    move.castle = 3 < g.castle.length ? 'queen' : 'king'
  } else if (null != g.piece) {
    move.piece = g.piece as Piece
    if (null != g.dfile || null != g.drank) {
      move.disambiguation = {}
      if (null != g.dfile) move.disambiguation.file = g.dfile
      if (null != g.drank) move.disambiguation.rank = +g.drank
    }
    if (null != g.pcapture) move.capture = true
    move.to = g.pto
  } else {
    move.piece = 'P'
    if (null != g.pxfile) {
      move.disambiguation = { file: g.pfile }
      move.capture = true
      move.to = g.pxfile + g.prank
    } else {
      move.to = (g.pfile as string) + g.prank
    }
    if (null != g.promotion) move.promotion = g.promotion as PromotionPiece
  }

  // `++` is an old spelling of a double check; it is still just a check.
  if (null != g.check) move.check = '#' === g.check ? '#' : '+'
  if (null != g.annotation) move.annotation = g.annotation as Annotation

  return move
}

// --- Hand-written lex matchers -------------------------------------------

// These three are registered in the `lex.match` registry rather than as
// `match.token` regexes, because they are not gated by the token columns
// the active alternates declare: `{`, `;` and a first-column `%` mean the
// same thing wherever they appear, and a hand-written matcher can keep the
// row/column counters honest across the newlines they may span.

function makeCommentMatcher() {
  return function pgnComment(lex: any) {
    const pnt = lex.pnt
    if ('{' !== lex.src[pnt.sI]) return undefined

    const end = lex.src.indexOf('}', pnt.sI + 1)
    if (-1 === end) return lex.bad('unterminated_comment', pnt.sI, lex.src.length)

    const src = lex.src.substring(pnt.sI, end + 1)
    const tkn = lex.token('#CMT', src.substring(1, src.length - 1), src, pnt)
    advance(pnt, src)
    return tkn
  }
}

function makeRemarkMatcher() {
  return function pgnRemark(lex: any) {
    const pnt = lex.pnt
    if (';' !== lex.src[pnt.sI]) return undefined

    const src = lineFrom(lex.src, pnt.sI)
    const tkn = lex.token('#RMK', src.substring(1), src, pnt)
    advance(pnt, src)
    return tkn
  }
}

// PGN spec 6: a `%` in the FIRST column escapes the rest of the line for
// private use. A `%` anywhere else is an ordinary character.
function makeEscapeMatcher() {
  return function pgnEscape(lex: any) {
    const pnt = lex.pnt
    if (1 !== pnt.cI || '%' !== lex.src[pnt.sI]) return undefined

    const src = lineFrom(lex.src, pnt.sI)
    // #CM is in the IGNORE token set, so the parser never sees it.
    const tkn = lex.token('#CM', undefined, src, pnt)
    advance(pnt, src)
    return tkn
  }
}

function lineFrom(src: string, start: number): string {
  let end = start
  while (end < src.length && '\n' !== src[end] && '\r' !== src[end]) end++
  return src.substring(start, end)
}

// Move the lex point over `src`, keeping row and column true across any
// newlines inside it (a brace comment may span lines) so later parse
// errors still name the right place.
function advance(pnt: { sI: number; rI: number; cI: number }, src: string): void {
  let lastLine = -1
  for (let i = 0; i < src.length; i++) {
    if ('\n' === src[i]) {
      pnt.rI++
      lastLine = i
    }
  }
  pnt.sI += src.length
  pnt.cI = -1 === lastLine ? pnt.cI + src.length : src.length - lastLine
}

// --- Grammar actions -----------------------------------------------------

// Line bookkeeping (the running move number and side to move) is kept on
// the line node itself, but as non-enumerable properties, so the parse
// result stays plain JSON without a clean-up pass.
const COUNT = Symbol.for('@tabnas/chess:count')

interface Count {
  number: number
  side: Side
}

function counter(line: Line): Count {
  let count: Count = (line as any)[COUNT]
  if (null == count) {
    count = startOf(line)
    Object.defineProperty(line, COUNT, { value: count, writable: true })
  }
  return count
}

// A game with a `FEN` tag does not start at move 1 with White to move, and
// the tag is where the PGN standard (9.7) says to look. Fields 2 and 6 of
// a FEN record are the active colour and the fullmove number.
function startOf(line: Line): Count {
  const fen = (line as Game).tags?.FEN
  const count: Count = { number: 1, side: 'w' }
  if ('string' === typeof fen) {
    const field = fen.trim().split(/\s+/)
    if ('b' === field[1]) count.side = 'b'
    if (null != field[5] && /^\d+$/.test(field[5])) {
      const n = parseInt(field[5], 10)
      if (0 < n) count.number = n
    }
  }
  return count
}

function lineOf(rule: Rule): Line {
  return rule.node as Line
}

function annotate(rule: Rule, field: 'nags' | 'comments', value: any): void {
  const line = lineOf(rule)
  const target: any = 0 < line.moves.length ? line.moves[line.moves.length - 1] : line
    ; (target[field] = target[field] || []).push(value)
}

function makeComment(kind: 'brace' | 'line', text: string, parse: boolean): Comment {
  const comment: Comment = { kind, text }
  if (parse) {
    const { commands } = scanCommands(text)
    if (0 < commands.length) comment.commands = commands
  }
  return comment
}

function refs(san: RegExp, commands: boolean): Record<FuncRef, Function> {
  return {
    '@pgn-bo': (r: Rule) => {
      r.node = [] as Database
    },

    '@gameitem-bc': (r: Rule) => {
      if (null != r.child.node) (r.node as Database).push(r.child.node)
    },

    '@game-bo': (r: Rule) => {
      // A null-prototype tag map. PGN spec 8.1 allows any name of letters,
      // digits and underscore, which includes `__proto__` — and on an
      // ordinary object that assignment sets the prototype instead of a
      // property, so the tag would vanish from the parse result.
      r.node = { tags: Object.create(null), moves: [] } as Game
    },

    // `movetext` normally inherits the enclosing line and writes into it.
    // As a start rule it has no parent, so it allocates one.
    '@movetext-bo': (r: Rule) => {
      if (null == r.node) r.node = { moves: [] } as Line
    },

    '@tag': (r: Rule) => {
      // `r.node` is the game: `tag` and `tagbody` have no node of their own.
      const game = r.node as Game
      const name = r.o0.src
      // PGN spec 8.1: a tag name should not repeat; the first wins, as a
      // reader has no better rule for choosing between them.
      if (!Object.prototype.hasOwnProperty.call(game.tags, name)) {
        game.tags[name] = r.o1.val
      }
    },

    '@result-open': (r: Rule) => {
      ; (r.node as Game).result = r.o0.src as GameResult
    },

    '@result-close': (r: Rule) => {
      ; (r.node as Game).result = r.c0.src as GameResult
    },

    // A `[` after the movetext has started belongs to the next game, not
    // to this one's tag section.
    '@more-tags': (r: Rule) => {
      const game = r.node as Game
      return 0 === game.moves.length && null == game.result
    },

    // PGN spec 8.2.6: the termination marker is the last element of a
    // movetext section, so movetext after one belongs to the next game.
    // This is what lets `*1. e4 *` be two games.
    '@no-result': (r: Rule) => null == (r.node as Game).result,

    '@move': (r: Rule, ctx: Context) => {
      const line = lineOf(r)
      const count = counter(line)
      const move = decompose(san, r.o0, ctx)
      move.number = count.number
      move.side = count.side
      if ('w' === count.side) {
        count.side = 'b'
      } else {
        count.side = 'w'
        count.number++
      }
      line.moves.push(move)
    },

    '@bare-move': (r: Rule, ctx: Context) => {
      r.node = decompose(san, r.o0, ctx)
    },

    // PGN spec 8.2.2: the integer is the fullmove number of the move that
    // follows. Import format allows any number of periods, but three or
    // more is the export-format spelling for "Black to move", so it is
    // worth honouring where it appears.
    '@number': (r: Rule) => {
      const count = counter(lineOf(r))
      const src = r.o0.src
      count.number = parseInt(src, 10)
      const dots = src.length - src.replace(/\./g, '').length
      if (1 === dots) count.side = 'w'
      else if (1 < dots) count.side = 'b'
    },

    '@nag': (r: Rule) => {
      annotate(r, 'nags', parseInt(r.o0.src.substring(1), 10))
    },

    '@brace-comment': (r: Rule) => {
      annotate(r, 'comments', makeComment('brace', r.o0.val, commands))
    },

    '@line-comment': (r: Rule) => {
      annotate(r, 'comments', makeComment('line', r.o0.val, commands))
    },

    // A variation replaces the move it follows, so it starts on that
    // move's number and side, not on the next one.
    '@rav-bo': (r: Rule) => {
      const parent = lineOf(r.parent)
      const previous = parent.moves[parent.moves.length - 1]
      const line: Line = { moves: [] }
      const count: Count =
        null == previous
          ? { ...counter(parent) }
          : { number: previous.number as number, side: previous.side as Side }
      Object.defineProperty(line, COUNT, { value: count, writable: true })
      r.node = line
    },

    '@element-bc': (r: Rule) => {
      if (true !== r.u.rav) return
      const line = lineOf(r)
      // A variation replaces the move it follows; one that follows no move
      // annotates the line's starting position instead.
      const target: { variations?: Line[] } = line.moves[line.moves.length - 1] || line
        ; (target.variations = target.variations || []).push(r.child.node as Line)
    },
  } as Record<FuncRef, Function>
}

function decompose(san: RegExp, token: Token, ctx: Context): Move {
  const m = san.exec(token.src)
  /* c8 ignore next 3 */
  if (null == m) {
    throw ctx.tabnas.error('unexpected', { src: token.src })
  }
  return buildMove(m)
}

// --- The plugin ----------------------------------------------------------

export const Chess: Plugin = function Chess(tn: Tabnas, options?: ChessOptions) {
  const strict = true === options?.strict
  const commands = false !== options?.commands
  const start = options?.start || 'pgn'
  const san = sanPattern(strict)

  tn.options({
    // PGN's brackets are not JSON's: `[` `]` delimit tag pairs, `(` `)`
    // delimit variations, and `{` `}` are comment markers handled by a
    // matcher, so the JSON-shaped fixed tokens are retired.
    fixed: {
      token: {
        '#OB': null,
        '#CB': null,
        '#CL': null,
        '#CA': null,
        '#OS': '[',
        '#CS': ']',
        '#OP': '(',
        '#CP': ')',
      },
    },

    match: {
      // Order matters: `#RES` is tried before `#MVN` so the `1` of `1-0`
      // is never mistaken for a move number.
      token: {
        '#RES': RESULT,
        '#SAN': san,
        '#MVN': MOVE_NUMBER,
        '#NAG': strict ? NAG_STRICT : NAG,
        '#TGN': TAG_NAME,
      },
    },

    lex: {
      match: {
        pgnComment: { order: 1.2e6, make: makeCommentMatcher },
        pgnRemark: { order: 1.3e6, make: makeRemarkMatcher },
        pgnEscape: { order: 1.5e6, make: makeEscapeMatcher },
      },
      emptyResult: [],
    },

    tokenSet: {
      // What may start a movetext element.
      ELEM: ['#SAN', '#MVN', '#NAG', '#CMT', '#RMK', '#OP'],
      // What may start a game: a tag pair, an element, or a bare result.
      HEAD: ['#OS', '#SAN', '#MVN', '#NAG', '#CMT', '#RMK', '#OP', '#RES'],
      // What ends an element sequence, to be re-read by an outer rule.
      EEND: ['#RES', '#OS', '#CP'],
    },

    // Every lexical atom of PGN has its own matcher above; a bareword or a
    // bare number outside them is not chess notation.
    text: { lex: false },
    number: { lex: false },
    // PGN's own comment styles are tokens this grammar keeps, not
    // whitespace the lexer may discard.
    comment: { lex: false },

    // PGN spec 7: a tag value is double-quoted, on one line, and the only
    // escapes are \" and \\.
    string: {
      chars: '"',
      multiChars: '',
      escapeStrict: true,
      escape: { n: null, t: null, r: null, b: null, f: null, v: null, '0': null },
      allowUnknown: true,
    },

    /* The engine's error text is written for someone debugging a grammar:
     * it reports the character class that did not match. Someone who fed
     * this a PGN file wants the vocabulary of chess notation instead, so
     * the plugin replaces the message for every code this grammar can
     * actually reach — `unexpected`, `unterminated_comment` and
     * `unprintable`, plus `unterminated_string` for completeness.
     *
     * Set here rather than in `parse` so that building the engine by hand
     * — `new Tabnas().use(Chess)` — gets them too.
     *
     * `{src}` is the offending source text, and is EMPTY when the notation
     * simply ran out. The messages have to read sensibly either way, which
     * is why none of them ends on the interpolation; the hint carries the
     * ran-out case.
     */
    error: {
      unexpected: 'not chess notation: {src}',
      unterminated_comment: 'this comment is never closed',
      unterminated_string: 'this tag value has no closing quote',
      unprintable: 'a tag value cannot contain a line break',
    },

    hint: {
      unexpected: `
Chess notation is a sequence of move numbers, moves, comments,
variations, glyphs and a result. Check for a stray character, or for
something that looks like a move but is not one — Ke9 names no square,
Nx names no destination. If the notation simply stops here, look instead
for a variation "(" or a tag "[" that was never closed.`,
      unterminated_comment: `
A brace comment runs from the opening brace to the next closing brace
(PGN spec 5). To put a comment on the rest of a line, start it with a
semicolon instead.`,
      unterminated_string: `
A tag value is a double-quoted string that ends on the line it starts on
(PGN spec 8.1).`,
      unprintable: `
A tag value is a double-quoted string on a single line (PGN spec 8.1).
The tag pair is probably missing its closing quote, so the value ran on
into the next line.`,
    },

    rule: { start },
  })

  const grammar = JSON.parse(grammarText)
  grammar.ref = refs(san, commands)
  tn.grammar(grammar, { rule: { alt: { g: 'chess' } } })
}

Chess.defaults = {
  strict: false,
  commands: true,
  start: 'pgn',
} as ChessOptions

// --- Convenience entry points --------------------------------------------

/**
 * Options for the database entry points. `start` is not among them: these
 * two functions parse a database, and their return types say so. Use the
 * plugin directly — `new Tabnas().use(Chess, { start: 'move' })` — for
 * another entry rule.
 */
export type DatabaseOptions = Omit<ChessOptions, 'start'>

/**
 * Whether to colour an error message.
 *
 * The engine turns colour on unconditionally, which is right for a
 * terminal and wrong everywhere else: in a browser, a log file or a CI
 * transcript the escape codes are noise wrapped around the message, and
 * in a browser they are visible noise. Follow the convention every other
 * tool follows — colour a real terminal, honour NO_COLOR, and stay quiet
 * anywhere there is no `process` at all.
 *
 * Only `parse` and `parseGame` apply this. They build the whole engine, so
 * the choice is theirs to make; a caller who builds their own engine has
 * already been handed the `color` option and should not have it taken
 * back by a plugin.
 */
function colour(): { active: boolean } {
  const proc = (globalThis as Record<string, any>).process
  if (null != proc?.env?.NO_COLOR && '' !== proc.env.NO_COLOR) return { active: false }
  return { active: true === proc?.stdout?.isTTY }
}

/** Parse a PGN database (zero or more games). */
export function parse(src: string, options?: DatabaseOptions): Database {
  // `start` is forced, not merely absent from the type: a JavaScript
  // caller has no type to stop them, and the return type would be a lie.
  return new Tabnas({ color: colour() }).use(Chess, { ...options, start: 'pgn' }).parse(src)
}

/** Parse a single game, or `undefined` if the source holds none. */
export function parseGame(src: string, options?: DatabaseOptions): Game | undefined {
  return parse(src, options)[0]
}

export default Chess
