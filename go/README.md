# github.com/tabnas/chess/go

A [Tabnas](https://github.com/tabnas/parser) grammar plugin that parses
**chess notation**: PGN games and the SAN moves inside them.

A port of the canonical TypeScript package
[`@tabnas/chess`](../ts/README.md). The grammar is not duplicated: both
runtimes embed the same JSON, generated from
[`chess-grammar.jsonic`](../chess-grammar.jsonic), and both run the same
`test/spec/*.tsv` conformance fixtures.

The repository hub, with the scope table and the grammar diagram, is
[`../README.md`](../README.md).

## Install

```bash
go get github.com/tabnas/chess/go@latest
```

## Use

```go
import chess "github.com/tabnas/chess/go"

db, err := chess.Parse(`[White "Fischer"]

1. e4 e5 2. Nf3 {solid} 1-0`)

db[0].Tags["White"]                // "Fischer"
db[0].Result                       // "1-0"
db[0].Moves[2].San                 // "Nf3"
db[0].Moves[2].Comments[0].Text    // "solid"
```

`Parse` reads a whole database; `ParseGame` reads the first game; and
`ParseSan` takes a single move apart without needing a parser at all:

```go
move, ok := chess.ParseSan("Qa6xb7#")
// move.Piece            == "Q"
// move.Disambiguation   == &chess.Disambiguation{File: "a", Rank: 6}
// move.Capture          == true
// move.To               == "b7"
// move.Check            == "#"
```

Building the grammar dominates a parse, so for bulk work build one engine
and reuse it:

```go
j := chess.Make()
for _, src := range sources {
    out, err := j.Parse(src)
    // out is *chess.Database
}
```

## Options

```go
chess.Make(chess.Options{Strict: true})
```

| Field | Meaning |
|---|---|
| `Strict` | Accept only export-format SAN (PGN spec 3, 8.2.3.7). |
| `Commands` + `CommandsSet` | Parse `[%name arg,arg]` comment markup. On by default; set both to turn it off, so the zero value still means "on". |
| `Start` | Entry rule: `"pgn"` (default), `"game"`, `"movetext"` or `"move"`. |

## Differences from the TypeScript implementation

The **model and the accepted notation are identical** — that is what the
shared fixtures pin. Three things differ because the languages do:

1. **`Parse` returns `Database` (a slice), and the engine's node is
   `*Database`.** A Go slice is a value, so the rule that appends each
   game has to write through a pointer.

2. **`Game` embeds `Line` anonymously** rather than extending it, so the
   two marshal to the same JSON object.

3. **The lexer's boundary guards are code, not lookahead.** Go's RE2 has
   no `(?!…)`, so the PGN section 7 rule that a symbol token ends before
   the first non-symbol character is a bounds check the matcher runs after
   the match, rather than part of the pattern. Same rule, checked one step
   later — `e2e4` is rejected in both runtimes.

`Options` is also a struct here rather than an object literal, which is
why turning `Commands` *off* needs `CommandsSet`.

## Documentation

The four-quadrant [Diátaxis](https://diataxis.fr) docs are shared with the
TypeScript package; the examples are TypeScript but the model, the
options and the accepted notation are the same:

- [tutorial.md](../ts/doc/tutorial.md) — zero to a working parser.
- [guide.md](../ts/doc/guide.md) — recipes for real problems.
- [reference.md](../ts/doc/reference.md) — options, types, notation accepted.
- [concepts.md](../ts/doc/concepts.md) — the data model and the grammar,
  and why both look the way they do.

## Build and test

```bash
go build ./...
go test ./...        # the shared fixtures, plus a Go-side suite
```

## License

MIT. Copyright (c) Richard Rodger.
