# How-to guide

Focused recipes for real problems. Each is independent; jump to the one you
need. For the full API see [reference.md](reference.md); for the "why" see
[concepts.md](concepts.md).

## Parse one move instead of a whole game

`parseSan` takes a move string and gives back the move, or `undefined` if
the string is not a move at all. It never throws.

```js
const { parseSan } = require('@tabnas/chess')

parseSan('exd5').capture // => true
parseSan('e9')           // => undefined
```

To get the same thing through the engine — with a parse *error* rather than
`undefined`, and with the position reported — use the `move` start rule:

```js
const { Tabnas } = require('@tabnas/parser')
const { Chess } = require('@tabnas/chess')

const tn = new Tabnas().use(Chess, { start: 'move' })

tn.parse('O-O-O').castle // => 'queen'
```

## Parse movetext with no tag pairs around it

Analysis output and opening books are often bare move sequences. The
`movetext` start rule reads one, and returns a line rather than a game:

```js
const { Tabnas } = require('@tabnas/parser')
const { Chess } = require('@tabnas/chess')

const tn = new Tabnas().use(Chess, { start: 'movetext' })
const line = tn.parse('1. d4 Nf6 2. c4 e6')

line.moves.length // => 4
line.moves[3].san // => 'e6'
```

## Walk every move, variations included

A variation is a `Line`, and a game is a `Line` too, so one recursive walk
covers both:

```js
const { parseGame } = require('@tabnas/chess')

function walk(line, visit, depth = 0) {
  for (const move of line.moves) {
    visit(move, depth)
    for (const variation of move.variations || []) {
      walk(variation, visit, depth + 1)
    }
  }
}

const game = parseGame('1. e4 e5 (1... c5 2. Nf3 (2. Nc3)) 2. Nf3 *')
const seen = []
walk(game, (move, depth) => seen.push(`${'  '.repeat(depth)}${move.san}`))

seen.length // => 6
seen[2]     // => '  c5'
seen[4]     // => '    Nc3'
```

## Pull clock times and evaluations out of comments

lichess, chess.com and ChessBase hide structured data inside comments as
`[%name arg,arg]` markup. It is parsed by default:

```js
const { parseGame } = require('@tabnas/chess')

const game = parseGame('1. e4 { [%clk 0:02:58] [%eval 0.31] } *')
const commands = game.moves[0].comments[0].commands

commands[0] // => ({ name: 'clk', args: ['0:02:58'] })
commands[1] // => ({ name: 'eval', args: ['0.31'] })
```

A small helper turns that into the shape you probably want:

```js
const { parseGame } = require('@tabnas/chess')

function commandsOf(move) {
  const out = {}
  for (const comment of move.comments || []) {
    for (const command of comment.commands || []) {
      out[command.name] = command.args
    }
  }
  return out
}

const game = parseGame('1. e4 { [%clk 0:02:58] } *')

commandsOf(game.moves[0]).clk // => (['0:02:58'])
```

The comment text is kept verbatim, markup included, so nothing is lost. Use
`stripCommands` when you want the prose on its own:

```js
const { stripCommands } = require('@tabnas/chess')

stripCommands('A quiet move [%clk 0:02:58] with a plan.') // => 'A quiet move with a plan.'
```

## Turn suffix annotations into glyphs

Import format allows `Qxa8?`; export format writes `Qxa8 $2`. The mapping is
exported, so you can normalise one into the other:

```js
const { parseGame, ANNOTATION_NAG } = require('@tabnas/chess')

const move = parseGame('1. Qxa8? *').moves[0]
const nags = (move.nags || []).concat(
  move.annotation ? [ANNOTATION_NAG[move.annotation]] : [],
)

move.san // => 'Qxa8'
nags     // => ([2])
```

## Insist on export-format notation

`strict: true` accepts only what a PGN *writer* is allowed to emit. Use it
to validate your own output, or to catch a file that has been hand-edited:

```js
const { Tabnas } = require('@tabnas/parser')
const { Chess } = require('@tabnas/chess')

const strict = new Tabnas().use(Chess, { strict: true })
let rejected = false
try {
  strict.parse('1. e4 0-0 *')
} catch (err) {
  rejected = true
}

rejected // => true
```

The full list of what strict mode refuses is in
[reference.md](reference.md#import-format-vs-export-format).

## Handle a parse error

A failed parse throws, and the error carries the position:

```js
const { parse } = require('@tabnas/chess')

let message = ''
try {
  parse('[Event "x"]\n\n1. e4 zz')
} catch (err) {
  message = err.message
}

message.includes('3:7') // => true
```

## Read a large PGN file game by game

`parse` builds the whole database in memory. For a file too big for that,
split on the blank line before each tag section and parse one game at a
time:

```js
const { parseGame } = require('@tabnas/chess')

function* games(source) {
  for (const chunk of source.split(/\n\s*\n(?=\[)/)) {
    if ('' !== chunk.trim()) yield parseGame(chunk)
  }
}

const found = [...games('[W "a"]\n1. e4 1-0\n\n[W "b"]\n1. d4 0-1')]

found.length          // => 2
found[1].tags.W       // => 'b'
```

That split is a heuristic about *layout*, not grammar — it works because
export-format PGN puts a blank line before every tag section (8.2.1). Where
layout cannot be trusted, `parse` on the whole source is the correct answer:
the grammar starts a new game at a tag pair regardless of whitespace.

## Write notation back out

Nothing here writes PGN, but the model holds everything needed to. Moves
keep their `san` verbatim, so a mainline round-trips in a few lines:

```js
const { parseGame } = require('@tabnas/chess')

function toMovetext(game) {
  const out = []
  for (const move of game.moves) {
    if ('w' === move.side) out.push(move.number + '.')
    out.push(move.san + (move.annotation || ''))
    for (const nag of move.nags || []) out.push('$' + nag)
    for (const comment of move.comments || []) out.push('{' + comment.text + '}')
  }
  if (game.result) out.push(game.result)
  return out.join(' ')
}

toMovetext(parseGame('1. e4 e5 2. Nf3 {solid} 1-0'))
// => '1. e4 e5 2. Nf3 {solid} 1-0'
```

## Inspect the grammar

The grammar is data, so tooling can read it back. `@tabnas/debug` describes
it and `@tabnas/railroad` draws it:

```js ignore
const { Tabnas } = require('@tabnas/parser')
const { Chess } = require('@tabnas/chess')
const { railroad } = require('@tabnas/railroad')

const tn = new Tabnas().use(Chess).use(railroad)

require('node:fs').writeFileSync('grammar.svg', tn.railroad.toSvg())
```

That is exactly how [`grammar.svg`](grammar.svg) and
[`grammar.txt`](grammar.txt) are generated — from the live grammar, never by
hand.
