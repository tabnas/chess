# &lt;chess-game&gt;

A self-contained web component that shows a PGN game as a classic 2D
chessboard, with controls to step through it and the notation highlighted
move by move.

```html
<script src="chess-game.js"></script>

<chess-game>1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1/2-1/2</chess-game>
```

The game is the element's **text content**. There is no configuration, no
JSON, and no second file: `@tabnas/chess` and the `@tabnas/parser` engine
are bundled in, the styles are inline, and the board is inline SVG.

![the component showing the Immortal Game](doc/screenshot.png)

## Install

### From a CDN

One tag, nothing to build:

```html
<script src="https://cdn.jsdelivr.net/npm/@tabnas/chess-game@0.1.0"></script>

<chess-game>1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1/2-1/2</chess-game>
```

[unpkg](https://unpkg.com) serves the same file from
`https://unpkg.com/@tabnas/chess-game@0.1.0`. Both resolve the bare
package URL to `dist/chess-game.js`, the minified IIFE build.

As a module, in a page or from an import map:

```html
<script type="module"
  src="https://cdn.jsdelivr.net/npm/@tabnas/chess-game@0.1.0/dist/chess-game.mjs"></script>
```

**Pin the version.** The examples above pin `@0.1.0`; the same URLs
without it follow the latest release, which is convenient right up until
it is not. And once pinned, a version is immutable on both CDNs, so it can
be checked:

```html
<script src="https://cdn.jsdelivr.net/npm/@tabnas/chess-game@0.1.0"
        integrity="sha384-…" crossorigin="anonymous"></script>
```

Each release ships the hashes of the files it published, so the value for
the version you pinned is at
`https://cdn.jsdelivr.net/npm/@tabnas/chess-game@0.1.0/dist/sri.json`.

### From npm

```bash
npm install @tabnas/chess-game
```

```js
import '@tabnas/chess-game'
```

The package has **no dependencies**: `@tabnas/chess` and the
`@tabnas/parser` engine are bundled in, and so are the TypeScript
declarations, so nothing else is installed to make either work.

Both module systems are covered — `require('@tabnas/chess-game')` and
`import '@tabnas/chess-game'` — and importing it on a server is safe:
nothing touches the DOM until the element is registered, and registration
is skipped where there is no custom element registry.

Importing registers `<chess-game>`. To register it under a different name,
import `define`:

```js
import { define } from '@tabnas/chess-game'
define('pgn-viewer')
```

### TypeScript

The declarations ship with the package, and are wired into the editor's
own model of HTML:

```ts
import '@tabnas/chess-game'

const board = document.querySelector('chess-game') // ChessGameElement
board?.goto(3)

document.addEventListener('chess-move', (e) => {
  e.detail.move?.san // string | undefined
})
```

`custom-elements.json` — a [custom elements
manifest](https://github.com/webcomponents/custom-elements-manifest) — is
published too, so editors that read it complete the tag, its attributes,
its CSS parts and its custom properties in plain HTML and CSS as well.

## Use

### Attributes

| Attribute | Values | Meaning |
|---|---|---|
| `orientation` | `white` (default), `black` | Which side is at the bottom. |
| `game` | a number | Which game of a multi-game database to show. Default `0`. |
| `ply` | a number | Which move to open at. `0` is the starting position. |
| `theme` | `auto` (default), `dark` | `auto` follows `prefers-color-scheme`. |

### Controls

Buttons for start / previous / next / end / flip, and the same from the
keyboard when the component has focus: <kbd>←</kbd> <kbd>→</kbd>
<kbd>Home</kbd> <kbd>End</kbd> <kbd>f</kbd>.

Clicking any move in the notation jumps to it — including a move inside a
variation, after which <kbd>←</kbd> and <kbd>→</kbd> walk **that**
variation. <kbd>Home</kbd> (or ⏮) returns to the game's start and to the
mainline.

### Events

`chess-move` fires on every navigation, and bubbles:

```js
document.addEventListener('chess-move', (e) => {
  console.log(e.detail.ply, e.detail.move?.san)
})
```

`e.detail.move` is the parsed move from
[`@tabnas/chess`](../ts/doc/reference.md#move) — `san`, `piece`, `to`,
`disambiguation`, `capture`, `promotion`, `check`, `nags`, `comments` and
so on — or `undefined` at the starting position.

### Properties and methods

| | |
|---|---|
| `el.move` | The move currently shown, or `undefined`. |
| `el.ply` | How far into the current line the view is; `0` is the start. |
| `el.goto(n)` | Show the `n`th move of the current line. |
| `el.load()` | Re-read the text content. Called automatically on change. |

### The board, without the element

The replay half is a subpath of its own, with no DOM in it — for working
out positions on a server, in a worker, or in a test:

```js
import { startPosition, legalMoves, resolve, applyMove } from '@tabnas/chess-game/engine'

const pos = startPosition()
legalMoves(pos).length              // => 20
applyMove(pos, resolve(pos, { san: 'e4', piece: 'P', to: 'e4' })).turn  // => 'b'
```

### Styling

Everything is a custom property, set on the element or inherited:

```css
chess-game {
  --size: 30rem;          /* board width */
  --board-light: #eeeed2;
  --board-dark: #769656;
  --accent: #4a7c59;      /* the highlighted move */
}
```

The full list is at the top of [`src/style.ts`](src/style.ts), and in
[`custom-elements.json`](custom-elements.json) with a description of each.
The shadow root also exposes `::part(board)`, `::part(notation)`,
`::part(moves)`, `::part(controls)` and `::part(wrap)`.

## Build

```bash
npm install
npm run build          # dist/
npm start              # serve the demo with rebuild-on-save
npm test               # engine tests, then the component in Chromium
```

`build.js` produces:

| File | Format | For |
|---|---|---|
| `chess-game.js` | IIFE, minified | a `<script src>` tag or a CDN |
| `chess-game.mjs` | ESM, minified | `import`, bundlers, `<script type="module">` |
| `chess-game.cjs` | CJS, minified | `require` |
| `chess-game.dev.js` | IIFE, readable, sourcemapped | debugging |
| `engine.cjs`, `engine.mjs` | CJS and ESM | replaying a game with no DOM |
| `chess-game.d.ts`, `engine.d.ts` | declarations | TypeScript |

The extensions are load-bearing rather than decorative. Node decides a
file's module format from its extension and the nearest package.json
`type`, so an ES module named `.js` in a `"type": "commonjs"` package is a
syntax error on `require` *and* on `import` — a way to publish a package
nobody can load. `.mjs` and `.cjs` say which is which outright.

…plus `sri.json`, the integrity hashes, and `index.html`, the demo — so
`dist/` is a complete site you can upload as it stands. About 95 kB
minified, 34 kB over the wire, most of which is the parser engine.

The declarations are bundled the same way the code is: `el.move` is a
`Move` from `@tabnas/chess`, and a `.d.ts` that said so by importing it
would make a zero-dependency package need a dependency in order to
typecheck. `build.js` inlines every type the public surface reaches, then
typechecks the result — a declaration that fails does so in the consumer's
build, which is far too late to find out.

## What this is, and what the parser is

`@tabnas/chess` deliberately has **no board**. `Nf3` names a piece and a
destination; a parser cannot know *which* knight without the position, and
it does not pretend to. See
[`ts/doc/concepts.md`](../ts/doc/concepts.md#1-the-data-structure) for why.

A board view has to know. So [`src/position.ts`](src/position.ts) is the
missing half: a small legal move generator that resolves each parsed move
against the running position. "Legal", not "plausible" — PGN spec 8.2.3.4
notes that two knights attacking the same square need no disambiguation if
one of them is pinned, so getting the *notation* right requires check
detection.

That generator is tested with [perft](test/engine.test.js), the standard
correctness check for chess move generation: it counts leaf nodes to a
fixed depth from six known positions and compares against published
numbers. A single missing en-passant capture changes the count.

A consequence worth knowing: the parser accepts any well-formed SAN move,
but the component can only *show* one that is legal in the position
reached. A move that is good notation and not a legal move stops its line
and is flagged — a different failure from a syntax error, and reported as
one.

## Not included

- **Playing.** The board is a view; pieces are not draggable.
- **Chess960.** Castling assumes the standard king and rook squares.
- **Threefold repetition, the fifty-move rule, insufficient material.**
  Nothing here adjudicates a game; it replays one.

## License

MIT. Copyright (c) Richard Rodger.
