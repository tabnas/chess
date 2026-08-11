# Tutorial

Zero to a working chess-notation parser, step by step. By the end you will
have read a game out of a PGN file, walked its moves, and followed a
variation. For task-sized recipes see [guide.md](guide.md); for the exact
API see [reference.md](reference.md).

## 1. Install

`@tabnas/chess` is a grammar plugin, so it needs the engine alongside it:

```bash
npm install @tabnas/parser @tabnas/chess
```

## 2. Parse your first move

The quickest thing you can do is read a single move:

```js
const { parseSan } = require('@tabnas/chess')

const move = parseSan('Nf3')

move.piece // => 'N'
move.to    // => 'f3'
```

`piece` is the letter the PGN standard uses for a knight, and `to` is the
destination square. Notice what is *not* there: no `from`. A pawn move fills
in the piece letter the notation leaves out:

```js
const { parseSan } = require('@tabnas/chess')

parseSan('e4').piece // => 'P'
parseSan('e4').to    // => 'e4'
```

## 3. Parse a game

Real notation comes in games. `parseGame` reads one:

```js
const { parseGame } = require('@tabnas/chess')

const game = parseGame('1. e4 e5 2. Nf3 Nc6 1/2-1/2')

game.moves.length  // => 4
game.result        // => '1/2-1/2'
game.moves[2].san  // => 'Nf3'
```

Every move carries its place in the game, whether or not the notation
bothered to write a number:

```js
const { parseGame } = require('@tabnas/chess')

const game = parseGame('e4 e5 Nf3 *')

game.moves[0].number // => 1
game.moves[0].side   // => 'w'
game.moves[1].side   // => 'b'
game.moves[2].number // => 2
```

## 4. Read the tag pairs

The bracketed header of a PGN file is the *tag pair section*. It arrives as
a plain object of raw strings:

```js
const { parseGame } = require('@tabnas/chess')

const game = parseGame(`
[Event "F/S Return Match"]
[White "Fischer, Robert J."]
[Result "1/2-1/2"]

1. e4 e5 1/2-1/2
`)

game.tags.Event  // => 'F/S Return Match'
game.tags.White  // => 'Fischer, Robert J.'
game.tags.Result // => '1/2-1/2'
```

Tag values stay exactly as written. Turning `"1992.11.04"` into a date is a
job for your code, not the parser's — see
[concepts.md](concepts.md#raw-tag-values).

## 5. Follow the annotations

Comments, glyphs and variations attach to the move they follow:

```js
const { parseGame } = require('@tabnas/chess')

const game = parseGame('1. e4 {Best by test.} $1 e5 (1... c5 2. Nf3) *')

game.moves[0].comments[0].text            // => 'Best by test.'
game.moves[0].nags                        // => ([1])
game.moves[1].variations[0].moves[0].san  // => 'c5'
```

A variation is the same shape as a game's own line of play, so the same code
walks both. And because it *replaces* the move it follows, it starts on that
move's number and side:

```js
const { parseGame } = require('@tabnas/chess')

const game = parseGame('1. e4 e5 (1... c5 2. Nf3) *')
const sicilian = game.moves[1].variations[0]

sicilian.moves[0].number // => 1
sicilian.moves[0].side   // => 'b'
sicilian.moves[1].number // => 2
sicilian.moves[1].side   // => 'w'
```

## 6. Read a whole file

A PGN file may hold many games. The default entry point reads all of them:

```js
const { parse } = require('@tabnas/chess')

const database = parse(`
[White "A"]
1. e4 1-0

[White "B"]
1. d4 0-1
`)

database.length            // => 2
database[1].tags.White     // => 'B'
database[1].result         // => '0-1'
```

In real life that source would come from a file:

```js ignore
const { readFileSync } = require('node:fs')
const { parse } = require('@tabnas/chess')

const database = parse(readFileSync('games.pgn', 'utf8'))
console.log(`${database.length} games`)
```

## 7. Use the engine directly

`parse` and `parseGame` are conveniences. Install the plugin on a Tabnas
engine when you want to hold on to a configured parser, or compose it with
other plugins:

```js
const { Tabnas } = require('@tabnas/parser')
const { Chess } = require('@tabnas/chess')

const tn = new Tabnas().use(Chess, { strict: true })

tn.parse('1. e4 O-O *')[0].moves[1].castle // => 'king'
```

That `strict: true` asks for export-format notation only. Import format —
the default — accepts what people actually type:

```js
const { Tabnas } = require('@tabnas/parser')
const { Chess } = require('@tabnas/chess')

const tn = new Tabnas().use(Chess)

tn.parse('1. e4 0-0 *')[0].moves[1].castle // => 'king'
```

Under `strict: true` that same `0-0` is rejected, because the standard spells
castling with the letter O.

## Where next

- [guide.md](guide.md) — recipes: streaming a large file, pulling clock
  times out of comments, walking variations, writing notation back out.
- [reference.md](reference.md) — every option, every type, every export.
- [concepts.md](concepts.md) — why the model looks like this, and how the
  grammar is put together.
