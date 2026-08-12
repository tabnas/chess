# @tabnas/chess

A [Tabnas](https://github.com/tabnas/parser) grammar plugin that parses
**chess notation**: PGN games and the SAN moves inside them.

The repository hub, with the scope table and the grammar diagram, is
[`../README.md`](../README.md). This file is the package's own entry point.

## Install

```bash
npm install @tabnas/parser @tabnas/chess
```

`@tabnas/parser` is a peer dependency. No other grammar is needed
underneath — this plugin installs on a bare engine.

## Use

```js
const { Tabnas } = require('@tabnas/parser')
const { Chess } = require('@tabnas/chess')

const tn = new Tabnas().use(Chess)
const game = tn.parse('[White "Fischer"]\n\n1. e4 e5 2. Nf3 {solid} 1-0')[0]

game.tags.White                // => 'Fischer'
game.result                    // => '1-0'
game.moves[2].san              // => 'Nf3'
game.moves[2].comments[0].text // => 'solid'
```

Or, without touching the engine:

```js
const { parse, parseGame, parseSan } = require('@tabnas/chess')

parse('1. e4 1-0\n\n1. d4 0-1').length // => 2
parseGame('1. e4 e5 *').moves.length   // => 2
parseSan('O-O-O').castle               // => 'queen'
```

## Documentation

Four-quadrant [Diátaxis](https://diataxis.fr) docs:

- [tutorial.md](doc/tutorial.md) — learning-oriented: zero to a working
  parser, step by step.
- [guide.md](doc/guide.md) — task-oriented recipes for real problems.
- [reference.md](doc/reference.md) — the exact API surface, options and
  notation accepted.
- [concepts.md](doc/concepts.md) — the data model, the grammar, and why both
  look the way they do.

## Build and test

```bash
npm install
npm run build          # embed-grammar.js, then tsc --build src test
npm test               # node --test dist-test/*.test.js
```

`npm run build` embeds [`../chess-grammar.jsonic`](../chess-grammar.jsonic)
into `src/chess.ts` first. Never hand-edit between the `BEGIN/END EMBEDDED`
markers — edit the grammar and re-run `npm run embed`.

## License

MIT. Copyright (c) Richard Rodger.
