# Reference

The complete API surface, the option set, and the notation accepted. For an
introduction see [tutorial.md](tutorial.md); for recipes see
[guide.md](guide.md); for the design rationale see
[concepts.md](concepts.md).

All exports come from the package root:

```js
const {
  Chess, VERSION,
  parse, parseGame, parseSan,
  stripCommands, ANNOTATION_NAG,
} = require('@tabnas/chess')
```

## The plugin

### `Chess`

A Tabnas plugin. Install it on a bare engine — it is not a jsonic
extension, and needs no other grammar underneath.

```js
const { Tabnas } = require('@tabnas/parser')
const { Chess } = require('@tabnas/chess')

const tn = new Tabnas().use(Chess)

tn.parse('1. e4 *')[0].result // => '*'
```

`tn.parse(src)` then returns whatever the configured start rule builds — by
default a `Game[]`.

### `VERSION`

The package version, as a string. Checked against `package.json` by
`test/version.test.ts`.

## Options

Pass options as the second argument to `use`:

```js
const { Tabnas } = require('@tabnas/parser')
const { Chess } = require('@tabnas/chess')

const tn = new Tabnas().use(Chess, { strict: true, commands: false })

tn.parse('1. e4 {[%clk 0:01]} *')[0].moves[0].comments[0].commands // => undefined
```

| Option | Type | Default | Meaning |
|---|---|---|---|
| `strict` | boolean | `false` | Accept only export-format notation. See below. |
| `commands` | boolean | `true` | Parse `[%name arg,arg]` markup inside comments into `Comment.commands`. |
| `start` | string | `'pgn'` | Which rule to parse from, and so what `parse` returns. |

### Start rules

| `start` | Accepts | Returns |
|---|---|---|
| `pgn` | a whole database, zero or more games | `Game[]` |
| `game` | one tag section plus one movetext section | `Game` |
| `movetext` | an element sequence, no tag pairs | `Line` |
| `move` | a single SAN move | `Move` |

### Import format vs export format

The PGN standard defines two (section 3): *import* format is "intentionally
lax" and describes data prepared by hand; *export* format is what a program
is allowed to write. `strict: false` (the default) reads import format;
`strict: true` accepts only export format.

Six things are import-only:

| Written | Export format | Section |
|---|---|---|
| `0-0`, `0-0-0` | `O-O`, `O-O-O` — the letter, not the digit | 8.2.3.3 |
| `Pe4` | `e4` — no pawn letter | 8.2.3.2 |
| `e8Q` | `e8=Q` — promotion takes an equal sign | 8.2.3.3 |
| `e4!`, `e4??` | `e4 $1`, `e4 $4` — glyphs, not suffixes | 8.2.3.8 |
| `e4++` | `e4+` — there is no double-check marking | 8.2.3.5 |
| `$999` | `$0` … `$255` | 8.2.4 |

Everything else — free layout, missing move numbers, a missing termination
marker, superfluous move numbers — is accepted by both, because the standard
does not require otherwise.

## Functions

### `parse(src, options?) => Game[]`

Parse a PGN database. Throws on malformed notation; returns `[]` for empty
source.

`options` is `DatabaseOptions` — `ChessOptions` without `start`. These two
functions parse a database and their return types say so, so the start rule
is fixed at `pgn` (in the types, and at run time for callers who have
none). Install the plugin directly for another entry rule.

```js
const { parse } = require('@tabnas/chess')

parse('1. e4 1-0\n\n1. d4 0-1').length // => 2
parse('').length                       // => 0
```

### `parseGame(src, options?) => Game | undefined`

The first game of `parse(src, options)`, or `undefined` if there is none.
Takes `DatabaseOptions`, as `parse` does.

```js
const { parseGame } = require('@tabnas/chess')

parseGame('1. e4 e5 *').moves.length // => 2
parseGame('')                        // => undefined
```

### `parseSan(src, options?) => Move | undefined`

Take a single SAN move string apart. Returns `undefined` rather than
throwing when `src` is not a move — the whole string must be one move, so a
prefix match does not count.

```js
const { parseSan } = require('@tabnas/chess')

parseSan('Nbd7').disambiguation // => ({ file: 'b' })
parseSan('e4e5')                // => undefined
```

Only `strict` is read from `options`; the move carries no `number` or
`side`, because a move on its own has no place in a game.

### `stripCommands(text) => string`

Remove `[%name …]` markup from a comment body, collapse the whitespace it
leaves behind, and trim.

```js
const { stripCommands } = require('@tabnas/chess')

stripCommands('good [%clk 0:05:00] move') // => 'good move'
```

## Errors

A parse failure throws. The error carries `code`, `lineNumber` and
`columnNumber` alongside the message, so a caller can rebuild the wording
for its own audience rather than scraping the text.

The messages are the grammar's, not the engine's. `Chess` replaces the
template for every code this grammar can reach, so they speak about chess
notation instead of about character classes:

| Code | Message |
|---|---|
| `unexpected` | not chess notation: `{src}` |
| `unterminated_comment` | this comment is never closed |
| `unterminated_string` | this tag value has no closing quote |
| `unprintable` | a tag value cannot contain a line break |

Each has a longer `hint` behind it, which the engine prints under the
source excerpt. Both are set through the engine's own `error` and `hint`
options, so a caller who wants different wording can override them the
same way — the plugin sets them, it does not own them.

### Colour

`parse` and `parseGame` colour an error **only** when standard output is a
real terminal, and never when `NO_COLOR` is set. The engine's own default
is to colour unconditionally, which is right for a terminal and wrong in a
browser, a log file or a CI transcript — in a browser the escape codes are
visible noise.

This applies to those two functions only. Building the engine by hand
means the `color` option is yours:

```js
new Tabnas({ color: { active: false } }).use(Chess)
```

### `ANNOTATION_NAG`

The glyph each traditional suffix annotation maps to (8.2.3.8, 10).

```js
const { ANNOTATION_NAG } = require('@tabnas/chess')

ANNOTATION_NAG['!']  // => 1
ANNOTATION_NAG['?']  // => 2
ANNOTATION_NAG['!!'] // => 3
ANNOTATION_NAG['??'] // => 4
ANNOTATION_NAG['!?'] // => 5
ANNOTATION_NAG['?!'] // => 6
```

## Types

### `Move`

One move, as written. Every field is something the notation stated; a field
the notation did not state is absent, never guessed.

| Field | Type | Present when |
|---|---|---|
| `san` | string | always — the move verbatim, minus any suffix annotation |
| `piece` | `'P' \| 'N' \| 'B' \| 'R' \| 'Q' \| 'K'` | always — `P` for a pawn move, `K` for castling |
| `to` | string | always except castling — the destination square, e.g. `'e4'` |
| `disambiguation` | `{ file?: string, rank?: number }` | the notation stated part of the origin (8.2.3.4), including the file of a capturing pawn |
| `capture` | `true` | the move is written as a capture |
| `promotion` | `'N' \| 'B' \| 'R' \| 'Q'` | the move promotes |
| `castle` | `'king' \| 'queen'` | the move is castling |
| `check` | `'+' \| '#'` | a check or checkmate indicator was written (8.2.3.5) |
| `annotation` | `'!' \| '?' \| '!!' \| '??' \| '!?' \| '?!'` | a suffix annotation was written (8.2.3.8) |
| `number` | number | in a game or movetext — the fullmove number |
| `side` | `'w' \| 'b'` | in a game or movetext — the side that played it |
| `nags` | `number[]` | glyphs follow the move |
| `comments` | `Comment[]` | comments follow the move |
| `variations` | `Line[]` | variations follow the move |

There is no `from`. A parser with no board cannot resolve the origin of
`Nf3`; `disambiguation` is what the notation actually said.

### `Line`

A move sequence: a game's mainline, or one variation.

| Field | Type | Present when |
|---|---|---|
| `moves` | `Move[]` | always |
| `comments` | `Comment[]` | comments precede the line's first move |
| `nags` | `number[]` | glyphs precede the line's first move |
| `variations` | `Line[]` | a variation precedes the line's first move |

An annotation belongs to the move it follows. The three optional fields here
hold the ones with no move to follow, which annotate the starting position.

### `Game`

A `Line`, plus the two things only a game has.

| Field | Type | Present when |
|---|---|---|
| `tags` | `Record<string, string>` | always — may be empty |
| `result` | `'1-0' \| '0-1' \| '1/2-1/2' \| '*'` | a termination marker was written |

Tag values are raw strings, in the order the file wrote them. A repeated tag
name keeps the first value (8.1 says a name should not repeat).

### `Comment`

| Field | Type | Present when |
|---|---|---|
| `kind` | `'brace' \| 'line'` | always — `{…}` or `;…` |
| `text` | string | always — the body verbatim, markup and whitespace included |
| `commands` | `Command[]` | `commands` is on and the body holds `[%…]` markup |

### `Command`

| Field | Type | Meaning |
|---|---|---|
| `name` | string | the word after `%` |
| `args` | `string[]` | the operands, in order |

`[%name]` with no operand gives `args: []`.

The syntax is the [PGN Specification
Supplement](https://www.ficsgames.org/pgnsupp.txt)'s (final draft, 2001),
not the 1994 standard's. An operand is either **bare** — any character but
a comma or a right bracket, trimmed — or a **double-quoted string**, which
may contain both and keeps its content without its quotes:

```js
parseGame('1. e4 {[%src "Lasker, Common Sense in Chess"]} *')
  .moves[0].comments[0].commands
// => [{ name: 'src', args: ['Lasker, Common Sense in Chess'] }]
```

Empty operands — from `a,,b`, or a trailing comma — contribute nothing. A
command that never closes is not a command: it stays in `text` as prose,
which is what the supplement asks of a reader that cannot make sense of
one.

The supplement defines four command names, all times: `clk`, `egt`, `emt`
and `mct`. `eval`, `csl` and `cal` are de facto, from lichess and
ChessBase. This parses the syntax and interprets none of the names.

## Notation accepted

### Tokens

| Token | Is | Section |
|---|---|---|
| `#SAN` | a SAN move, suffix annotation included | 8.2.3 |
| `#MVN` | a move number indication: digits, then zero or more periods | 8.2.2 |
| `#NAG` | `$` and digits | 8.2.4 |
| `#RES` | `1-0`, `0-1`, `1/2-1/2` or `*` | 8.2.6 |

| `#CMT` | `{ … }`, which may span lines and does not nest | 5 |
| `#RMK` | `;` to the end of the line | 5 |
| `#TGN` | a tag name: letters, digits, underscore | 8.1 |
| `#ST` | a tag value: `"…"`, one line, escapes `\"` and `\\` | 7 |
| `#OS` `#CS` | `[` and `]` | 7 |
| `#OP` `#CP` | `(` and `)` | 7 |

A `%` in the **first column** escapes the rest of the line (section 6); a
`%` anywhere else is an error.

A token ends before the first character that cannot continue a symbol
(section 7), so `e2e4` is one bad token rather than the two moves `e2` and
`e4` — and likewise `12e4` is not the move number `12` followed by `e4`.
The one exception is the asterisk, which section 7 makes a token by itself
and self-terminating, so `*1. e4` is a finished game and then another.

Two bounds follow from the same section. A move number starts at 1 —
section 8.2.2 says the indication gives the number of the move that
follows, and there is no move zero — and neither a move number nor a glyph
value may run past nine digits, which is far beyond any real game and keeps
an absurd literal away from the number parser.

### Rules

The grammar is [`chess-grammar.jsonic`](../../chess-grammar.jsonic), drawn
as a railroad diagram in [`grammar.svg`](grammar.svg) and
[`grammar.txt`](grammar.txt).

| Rule | Is |
|---|---|
| `pgn` | the start rule: a database of games |
| `gameitem` | one game, then the next |
| `game` | a tag section then a movetext section |
| `tag`, `tagbody` | `[ Name "Value" ]` |
| `movetext` | an element sequence |
| `element` | a move, a move number, a glyph, a comment, or a variation |
| `rav` | `( element-sequence )` |
| `move` | an alternate entry point: one SAN move |

### Errors

Errors are the engine's, so they name the file, row and column, and quote
the line. The codes you will see:

| Code | Raised when |
|---|---|
| `unexpected` | the characters at this position are not a token any active rule accepts |
| `unterminated_comment` | a `{` comment has no `}` |
| `unterminated_string` | a tag value has no closing quote |

## Limits

Move **legality** is not checked, and cannot be: there is no board here. A
syntactically perfect move to an impossible square parses fine.

Not implemented: FEN and EPD as standalone documents (16.1, 16.2) — the
`FEN` *tag* is read for its side-to-move and fullmove number, but its value
stays a raw string. Also not implemented: the non-standard `--` / `Z0` null
move and `(=)` draw offer that some tools emit.
