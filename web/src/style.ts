/* Copyright (c) 2026 Richard Rodger, MIT License */

/* The component's styles, as a string so the bundle stays one file.
 *
 * Everything a host might want to change is a custom property, and the
 * light and dark palettes are both defined here — a component dropped into
 * an unknown page cannot assume either.
 */

export const STYLE = `
:host {
  --board-light: #f0d9b5;
  --board-dark: #b58863;
  --board-from: #f7d64b;
  --board-to: #f7d64b;
  --board-check: #d64435;
  --piece-light: #fffef8;
  --piece-dark: #2b2724;
  --piece-edge: #2b2724;

  --fg: #1c1a18;
  --muted: #6b6560;
  --bg: #fbfaf8;
  --panel: #ffffff;
  --line: #e2ddd6;
  --accent: #2f6f4e;
  --accent-fg: #ffffff;
  --bad: #a3251b;

  --size: 24rem;
  --radius: 6px;
  --font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --glyphs: "Segoe UI Symbol", "Apple Symbols", "Noto Sans Symbols 2",
            "DejaVu Sans", "Free Serif", sans-serif;

  display: block;
  color: var(--fg);
  font-family: var(--font);
  font-size: 0.9rem;
  line-height: 1.5;
  contain: content;
}

@media (prefers-color-scheme: dark) {
  :host([theme="auto"]), :host(:not([theme])) {
    --board-light: #b8b0a4;
    --board-dark: #6f6459;
    --piece-light: #f6f3ee;
    --piece-dark: #1a1715;
    --piece-edge: #100e0d;
    --fg: #eae6e0;
    --muted: #a29a92;
    --bg: #1a1917;
    --panel: #232120;
    --line: #3a3734;
    --accent: #5fae86;
    --accent-fg: #10201a;
    --bad: #e88b80;
  }
}
:host([theme="dark"]) {
  --board-light: #b8b0a4;
  --board-dark: #6f6459;
  --piece-light: #f6f3ee;
  --piece-dark: #1a1715;
  --piece-edge: #100e0d;
  --fg: #eae6e0;
  --muted: #a29a92;
  --bg: #1a1917;
  --panel: #232120;
  --line: #3a3734;
  --accent: #5fae86;
  --accent-fg: #10201a;
  --bad: #e88b80;
}

:host(:focus-visible) { outline: 2px solid var(--accent); outline-offset: 3px; }
:host([hidden]) { display: none; }

.wrap {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  align-items: flex-start;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 0.85rem;
  box-sizing: border-box;
}

.boardpane { flex: 0 0 auto; width: var(--size); max-width: 100%; }
.boardbox { width: 100%; }

svg.board { display: block; width: 100%; height: auto; }
.sq.light { fill: var(--board-light); }
.sq.dark  { fill: var(--board-dark); }

/* Layered over the square, so a light square keeps its own colour under
   the mark rather than being replaced by a translucent one. */
.hl { pointer-events: none; }
.hl.from  { fill: var(--board-from); opacity: 0.42; }
.hl.to    { fill: var(--board-to); opacity: 0.62; }
.hl.check { fill: var(--board-check); opacity: 0.55; }

/* One glyph shape per piece, painted light or dark: the hollow "white"
   glyphs vary too much between fonts to sit beside the solid ones. */
.pc {
  font-family: var(--glyphs);
  font-size: 9.6px;
  text-anchor: middle;
  dominant-baseline: central;
  paint-order: stroke fill;
  stroke: var(--piece-edge);
  stroke-width: 0.35px;
  stroke-linejoin: round;
  pointer-events: none;
}
.pc.white { fill: var(--piece-light); }
.pc.black { fill: var(--piece-dark); }

.co {
  font-family: var(--font);
  font-size: 1.5px;
  fill: var(--muted);
  dominant-baseline: central;
}
.co.file { text-anchor: middle; }
.co.rank { text-anchor: end; }

.bar {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  margin-top: 0.5rem;
}
.bar button {
  font: inherit;
  line-height: 1;
  padding: 0.35rem 0.55rem;
  color: var(--fg);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  cursor: pointer;
}
.bar button:hover { border-color: var(--accent); }
.bar button:active { transform: translateY(1px); }
.bar button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.ply {
  margin-left: auto;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 0.8rem;
  font-variant-numeric: tabular-nums;
}

.side {
  flex: 1 1 14rem;
  min-width: 12rem;
  align-self: stretch;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.players { font-weight: 600; }
.meta { color: var(--muted); font-size: 0.82rem; }
.tags:empty { display: none; }

.moves {
  /* Hug the notation rather than stretch to the board's height: a short
     game beside a tall empty box looks broken. Long games still cap and
     scroll at max-height. */
  flex: 0 1 auto;
  max-height: var(--size);
  overflow-y: auto;
  padding: 0.5rem 0.6rem;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  font-family: var(--mono);
  font-size: 0.82rem;
  line-height: 1.9;
  overscroll-behavior: contain;
}
.moves:focus-visible { outline: 2px solid var(--accent); outline-offset: -1px; }

.no { color: var(--muted); }
.mv {
  font: inherit;
  color: inherit;
  background: none;
  border: 0;
  border-radius: 3px;
  padding: 0.05rem 0.25rem;
  cursor: pointer;
}
.mv:hover { background: var(--line); }
.mv.on { background: var(--accent); color: var(--accent-fg); }
.mv.bad { color: var(--bad); text-decoration: underline wavy; }
.mv:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

.cm { color: var(--muted); font-family: var(--font); font-style: italic; }
.nag { color: var(--accent); }
.var { color: var(--muted); }
.var .mv { font-size: 0.95em; }
.res { font-weight: 600; }

.note { color: var(--muted); font-size: 0.8rem; }
.note:empty { display: none; }
.note.bad { color: var(--bad); }

/* A command the supplement gives a meaning to — a clock, an evaluation —
   shown as its own chip rather than left as markup in the prose. */
.cmd {
  font-family: var(--mono);
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 0.05rem 0.4rem;
  margin: 0 0.15rem;
  white-space: nowrap;
}

.comment {
  padding: 0.5rem 0.6rem;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  font-size: 0.85rem;
}
.comment:empty { display: none; }
.comment p { margin: 0.35rem 0 0; }
.comment p:first-child { margin-top: 0; }
.comment .who {
  font-family: var(--mono);
  font-weight: 600;
  margin-right: 0.35rem;
}

.srcpane { flex: 1 1 100%; min-width: 0; }
.srcpane textarea {
  display: block;
  width: 100%;
  min-height: 6rem;
  box-sizing: border-box;
  resize: vertical;
  padding: 0.5rem 0.6rem;
  background: var(--panel);
  color: var(--fg);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  font-family: var(--mono);
  font-size: 0.8rem;
  line-height: 1.6;
  tab-size: 2;
}
.srcpane textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: -1px; }
.srcpane textarea:read-only { color: var(--muted); resize: none; }

/* The switches. Each hides a part of the UI without the component having
   to know it is hidden — the layout is flex, so a removed pane simply
   stops taking space. */
:host(:not([source="view"]):not([source="edit"])) .srcpane { display: none; }
:host([controls="hidden"]) .bar { display: none; }
:host([notation="hidden"]) .side { display: none; }
:host([tags="hidden"]) .tags { display: none; }
:host([coordinates="hidden"]) .co { display: none; }

/* With the notation gone the board is the whole component, so let it have
   the width rather than sitting in a column of its own. */
:host([notation="hidden"]) .boardpane { flex: 1 1 auto; }

@media (max-width: 30rem) {
  .wrap { gap: 0.75rem; }
  .boardpane { width: 100%; }
  .moves { max-height: 12rem; }
}
`
