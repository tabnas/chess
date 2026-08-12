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

Drop the built file on any page:

```html
<script src="https://cdn.example.com/chess-game.js"></script>
```

Or as a module:

```html
<script type="module">
  import 'https://cdn.example.com/chess-game.esm.js'
</script>
```

Or from a bundler:

```bash
npm install @tabnas/chess-game
```

```js
import '@tabnas/chess-game'
```

Importing registers `<chess-game>`. To register it under a different name,
import `define`:

```js
import { define } from '@tabnas/chess-game'
define('pgn-viewer')
```

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

The full list is at the top of [`src/style.ts`](src/style.ts). The shadow
root also exposes `::part(board)`, `::part(notation)`, `::part(moves)`,
`::part(controls)` and `::part(wrap)`.

## Build

```bash
npm install
npm run build          # dist/
npm start              # serve the demo with rebuild-on-save
npm test               # engine tests, then the component in Chromium
```

`build.js` produces four files:

| File | Format | For |
|---|---|---|
| `chess-game.js` | IIFE, minified | a `<script src>` tag or a CDN |
| `chess-game.esm.js` | ESM, minified | a bundler, or `<script type="module">` |
| `chess-game.dev.js` | IIFE, readable, sourcemapped | debugging |
| `engine.cjs` | CJS | replaying a game with no DOM |

…plus `index.html`, the demo, so `dist/` is a complete site you can upload
as it stands. About 95 kB minified, 34 kB over the wire — most of which is
the parser engine.

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
