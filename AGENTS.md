# Agents Guide — chess

> **Starting a new plugin from this repo?** Read
> **[`TEMPLATE.md`](TEMPLATE.md)** first — it covers the tabnas **engine
> model** (lexer + rules/alts), the **ecosystem map** (jsonic vs abnf vs
> the bare engine), **which files to copy vs rewrite**, and how to get a
> **green build in an isolated checkout**. This file documents
> `@tabnas/chess`'s own internals.

## What this project is

`@tabnas/chess` is a **grammar plugin** that parses chess notation: PGN
(Portable Game Notation) games and the SAN (Standard Algebraic Notation)
moves inside them.

```pgn
[Event "F/S Return Match"]
[Result "1/2-1/2"]

1. e4 e5 2. Nf3 {The main line.} Nc6 $1 (2... d6 3. d4) 1/2-1/2
```

Unlike `@tabnas/zon`, it is **not** a jsonic plugin: chess notation is not
JSON-shaped, so there is nothing in relaxed JSON worth inheriting. It
installs on the bare engine — `new Tabnas().use(Chess)` — the way
`@tabnas/json` does.

The reference document is the **PGN standard** (Steven J. Edwards, 1994).
Every section number in the source, the docs and the fixtures refers to it.
Read [`ts/doc/concepts.md`](ts/doc/concepts.md) before changing anything: it
is where the two load-bearing decisions are argued.

It does three things:

1. **Lexes the regular part of the notation** with five `match.token`
   regexes (`#SAN`, `#MVN`, `#NAG`, `#RES`, `#TGN`) and three hand-written
   `lex.match` matchers (`pgnComment`, `pgnRemark`, `pgnEscape`).
2. **Parses the recursive part** — games, tag pairs, variations — with nine
   rules in [`chess-grammar.jsonic`](chess-grammar.jsonic).
3. **Builds a plain game model** (`Game[]`) in the `ref` actions, rather
   than the engine's generic `{rule, src, kids}` tree.

## The two decisions that shape everything

**1. A SAN move is lexed whole, not parsed character by character.** PGN
section 7 classes it as a symbol token, and it has to be: the lexer skips
whitespace, so a scannerless grammar could not tell `Nb1 d2` (two moves)
from `Nb1d2` (one). The move grammar is not LL(1) either — `e4` and `exd5`
diverge three characters in — and the engine does not backtrack. So the
regular part lives in a regex and only the recursive part is a grammar.

**2. The model reports what the notation said, and nothing else.** There is
no `from`: a parser with no board cannot resolve the origin of `Nf3`.
`disambiguation` holds as much of the origin square as was written. Adding
an inferred field would make the parser a chess engine, and a bad one.

## Repository map

| Path | What it is |
|---|---|
| [`chess-grammar.jsonic`](chess-grammar.jsonic) | **Single source of truth** for the rule table, authored in jsonic so it can carry comments. |
| [`ts/embed-grammar.js`](ts/embed-grammar.js) | Converts the grammar to JSON and embeds it in `ts/src/chess.ts` between `BEGIN/END EMBEDDED` markers. Runs as the first half of `npm run build`. `@tabnas/jsonic` is a **build-time** dependency only. |
| [`ts/src/chess.ts`](ts/src/chess.ts) | The plugin: types, lex matchers, options, `ref` actions, and the convenience entry points. |
| [`test/spec/`](test/spec/) | Shared `.tsv` conformance fixtures, auto-discovered by the runner. The preferred home for any case expressible as `input -> JSON`. See [`test/AGENTS.md`](test/AGENTS.md). |
| [`ts/test/`](ts/test/) | `chess.test.ts` (what a fixture cannot express), `parity.test.ts` (the fixtures), `debug-model.test.ts` (grammar shape via `@tabnas/debug`), `doc-examples.test.ts` (runs `// =>` assertions in the docs), `perf.test.ts`, `version.test.ts`. |
| [`ts/doc/`](ts/doc/) | Four-quadrant Diátaxis docs, plus `grammar.svg` / `grammar.txt` generated from the live grammar by `make diagram`. |

## Repo-specific gotchas

- **Custom match tokens are gated by the token columns.** A `match.token`
  matcher only runs where some active alternate names its token. That is
  what makes `Event` a tag name inside `[…]` and a lex error in the
  movetext — but it also means **every alternate must name the tokens it
  expects**, including ones it only wants to hand back with `b: 1`. A
  missing name shows up as `unexpected character(s)` on input that is
  obviously fine. This is why the grammar is full of `#EEND` alternates
  that do nothing but backtrack.

- **The three hand-written matchers are deliberately NOT gated.** `{`, `;`
  and a first-column `%` mean the same thing everywhere, so they live in
  the `lex.match` registry (orders 1.2e6 / 1.3e6 / 1.5e6, all below the
  fixed matcher at 2e6). Being hand-written is also what lets `pgnComment`
  keep `pnt.rI` / `pnt.cI` honest across a comment that spans lines; a
  regex matcher would leave every later error position wrong.

- **`comment.lex` is off.** PGN comments are content, not whitespace: they
  are `#CMT` / `#RMK` tokens the grammar keeps. The only thing genuinely
  discarded is the section 6 `%` escape, which is emitted as `#CM` (in the
  IGNORE set) because the standard says this kind of software should ignore
  it.

- **One regex lexes a SAN move AND takes it apart.** `sanPattern()` builds
  it with named groups; the lexer uses `m[0]` and `buildMove()` uses
  `m.groups`. Do not add a second pattern — the token boundary and the field
  values must not be able to disagree. `strict` builds a narrower regex from
  the same template for the same reason.

- **The `SYMBOL_TAIL` lookahead is load-bearing.** Without
  `(?![A-Za-z0-9_+#=:-])` the SAN regex matches the `e2` prefix of `e2e4`
  and the parse silently yields two moves. Section 7 says a symbol token
  ends before the first non-symbol character; that lookahead is that rule.

- **`#RES` must be registered before `#MVN`.** Token matchers run in `tin$`
  order, which is registration order, and `1-0` starts with a digit. There
  is a `(?![-/])` guard in `MOVE_NUMBER` as well — keep both.

- **Rules without a node inherit the enclosing one.** `movetext`, `element`,
  `tag` and `tagbody` have no node of their own, so `r.node` in their
  actions is the game or the variation. That is what makes a variation and
  a game the same shape. `@movetext-bo` allocates one only when `movetext`
  is the start rule and so has no parent.

- **Move numbering lives on the node, non-enumerably.** The running
  `{number, side}` counter hangs off the line under a `Symbol.for` key, so
  the parse result is plain JSON with no clean-up pass. `@rav-bo` seeds a
  fresh counter from the move the variation replaces.

- **A `[` after the movetext starts the NEXT game.** That is the
  `@more-tags` condition on one `game` close alternate, not a whitespace
  rule — blank lines between games are layout (8.2.1), not grammar.

## Authority and alignment rules

1. **The grammar source is single-sourced, not duplicated.**
   `chess-grammar.jsonic` is authored once; `embed-grammar.js` compiles it
   into the `grammarText` literal in `src/chess.ts`. **Never hand-edit the
   text between the `--- BEGIN/END EMBEDDED chess-grammar.jsonic ---`
   markers** — edit the `.jsonic` and re-run `npm run embed` (or `npm run
   build`, which embeds first).
2. **The grammar carries no functions.** Actions are `@ref` strings the
   plugin binds at load time; `embed-grammar.js` fails the build if an
   `a`/`c`/`h`/`e` field is anything but a string. That is what keeps the
   grammar shippable as data.
3. **Prefer a `test/spec/*.tsv` fixture** over an in-language assertion
   whenever a case is expressible as `input -> JSON`. The in-language suite
   keeps only what a fixture cannot express.
4. **Every claim about the notation cites a PGN section.** If you cannot
   name the section, the behaviour is a guess, and a guess does not belong
   in a conformance parser. Where the standard is silent (the `[%…]` comment
   markup), say so explicitly in the docs.
5. `VERSION` in `ts/src/chess.ts` MUST equal `ts/package.json` "version" —
   `ts/test/version.test.ts` reads that file and fails (never skips) on
   drift.

## Build & test

From `ts/`:

```bash
npm install            # installs the @tabnas/parser peer
npm run build          # node embed-grammar.js && tsc --build src test
npm test               # node --enable-source-maps --test "dist-test/*.test.js"
make diagram           # regenerate doc/grammar.{svg,txt} from the live grammar
```

The repo-root [`Makefile`](Makefile) wraps the same targets.

## Not implemented

Deliberate omissions, each argued in
[`ts/doc/concepts.md`](ts/doc/concepts.md#3-trade-offs):

- **Move legality.** No board, so no legality. `1. Qh8` parses.
- **FEN and EPD as standalone documents** (sections 16.1, 16.2). The `FEN`
  *tag* is read for its side-to-move and fullmove number; its value stays a
  raw string.
- **Non-standard tokens**: the `--` / `Z0` null move and the `(=)` draw
  offer some tools emit. Accepting them would mean a `Move` with no piece.
- **A Go port.** The template's dual-runtime layout is not used here; the
  shared `test/spec/*.tsv` fixtures are still in the cross-runtime format,
  so a port has a conformance suite waiting for it.
