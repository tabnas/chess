# tabnas-chess

Rust port of `@tabnas/chess`: a [Tabnas](https://github.com/tabnas/parser)
grammar plugin that parses chess notation: PGN (Portable Game Notation)
games and the SAN (Standard Algebraic Notation) moves inside them.

TypeScript is canonical and this port tracks it. The grammar is not
duplicated: all three runtimes embed the same JSON, generated from
[`../chess-grammar.jsonic`](../chess-grammar.jsonic) by
[`../ts/embed-grammar.js`](../ts/embed-grammar.js). The shared
[`../test/spec/*.tsv`](../test/spec) fixtures are the parity contract, and
`tests/parity_test.rs` runs every one of them.

```rust
use tabnas_chess::{parse, Side};

let games = parse("[Event \"Casual\"]\n\n1. e4 {Best by test.} e5 (1... c5) 1-0", &Default::default())?;
let game = &games[0];

assert_eq!("Casual", game.tags["Event"]);
assert_eq!(Some(tabnas_chess::GameResult::White), game.result);
assert_eq!("e4", game.line.moves[0].san);
assert_eq!("Best by test.", game.line.moves[0].comments[0].text);
assert_eq!("c5", game.line.moves[1].variations[0].moves[0].san);
assert_eq!(Some(Side::Black), game.line.moves[1].side);
# Ok::<(), tabnas_chess::ChessError>(())
```

`parse` builds an engine and reads the result into the typed model.
`make` hands you the engine instead, for another start rule or for reuse
across many parses. Building the grammar dominates a parse, so reuse it.

```rust
use tabnas_chess::{make, model_of, ChessOptions, Move, Start};

let tn = make(&ChessOptions { start: Start::Move, ..Default::default() })?;
let played: Move = model_of(&tn.parse("Qa6xb7#")?)?;

assert_eq!(Some("b7".to_string()), played.to);
assert_eq!(Some(6), played.disambiguation.unwrap().rank);
# Ok::<(), Box<dyn std::error::Error>>(())
```

`chess(&mut tn, &options)` installs the grammar on an engine you are
configuring yourself, and `plugin()` is the same thing as a
`Tabnas::use_plugin` descriptor for a caller who already holds an option
bag. Neither touches `color`: that is the caller's to choose, and only
`make`, which builds the engine, applies the usual terminal and
`NO_COLOR` gate.

## Depending on it

The engine crate is not published to crates.io, so this crate reaches it
by path, as a sibling checkout:

```text
<workspace>/
  parser/rs/     # github.com/tabnas/parser
  chess/rs/      # this crate
```

That is the same layout the TypeScript and Go sides already assume for
local development, and what CI provides by cloning the dependency
repositories beside this one. Clone `tabnas/parser` next to `tabnas/chess` and
`cargo build` works; move it and the path in `Cargo.toml` is the one line
to change.

## What differs from the other two ports

The behaviour is identical, which is what the shared fixtures pin, but
three things are spelled differently because the language is:

- **The parse result is a `tabnas::Value`, not a native tree.** The
  engine's node is a `Value`, so the actions build one, and `parse`
  reads it into `Game` through serde. The typed model is therefore
  the JSON shape rather than a second description of it, and `model_of`
  is the one step between a raw `Value` and the model, which is what a
  caller using another start rule needs.
- **Boundary guards are code, not lookahead.** Rust's `regex` crate has
  no `(?!…)`, so the PGN section 7 symbol-tail rule is a check the
  matcher runs after the match, exactly as in the Go port. Without it
  `e2e4` would lex as the two moves `e2` and `e4`, and a wrong parse is
  worse than an error.
- **Line bookkeeping lives in `MapRef::meta`.** The running move number
  and side to move are carried on the line node in a map that neither
  `Serialize` nor `to_json` emits, which is this port's answer to the
  non-enumerable `Symbol` property in TypeScript and the `json:"-"` field
  in Go. The parse result stays plain JSON with no clean-up pass.

One thing this port gets for free: the engine's lexer advances by Unicode
scalar and keeps `ri` and `ci` right as it goes, so a brace comment spanning
lines leaves later error positions right without the `advance` helper the
other two ports each hand-write.

`tabnas::Value` carries every number as an `f64`, the way JavaScript
does, so `to_json` puts an integral one back as an integer: a fixture
that says `{"rank":1}` means the integer, and so does a consumer.

## Development

```sh
cargo build --all-targets
cargo test --all-targets
cargo clippy --all-targets --all-features -- -D warnings
cargo fmt --all --check
```

From the repository root, `make build-rs` and `make test-rs` run the same
thing, and `make test` runs the TypeScript, Go, web, and Rust sides
together.

The crate declares Rust 1.85 as its minimum supported toolchain, matching
the engine.

## Building a release that uses this

The engine is a separate crate, so nothing in it is inlined into your
code unless your binary asks for that. The engine's own README documents
both settings and the measurements behind them; in short, put this in the
release profile of the crate that builds the final artefact:

```toml
[profile.release]
opt-level = 3
codegen-units = 1
lto = "fat"
```

and choose an allocator rather than leaving it to the platform.

## License

MIT. Copyright (c) Richard Rodger.
