# Agents Guide — shared spec fixtures

`spec/*.tsv` holds the conformance fixtures. The runner discovers every file
in this directory by listing it, so adding a `.tsv` runs it without touching
any code — in this runtime, and in any future runtime that reads the same
directory.

## Format

Tab-separated, one case per line, with a header row naming the columns.
Blank lines are skipped, and so are comment lines — a line starting with `#`
that contains no tab. (A data row always has at least one tab, so a `#`-
leading source still works.)

| Column | Meaning |
|---|---|
| `input` | Chess notation. Escapes `\n` `\r` `\t` `\\` are decoded. |
| `expected` | A JSON value (the parse result), or `ERROR` / `ERROR:<substring>` for inputs that must fail. |
| `opts` | Optional JSON object of plugin options (empty means defaults). |

`expected` and `opts` are **not** escape-decoded — they are raw JSON, so
JSON's own escape rules apply. To put a literal backslash in `input`, write
`\\`.

Results are compared after a JSON round-trip, so the fixture asserts the
shape a consumer actually receives.

The `opts` column is what keeps the fixtures readable: `{"start":"move"}`
makes a row one move, `{"start":"movetext"}` makes it one line of play, and
the default makes it a whole database.

## The files

| File | Covers | PGN section |
|---|---|---|
| `san.tsv` | SAN move decomposition, one move per row | 8.2.3 |
| `movetext.tsv` | Element sequences, move numbers, glyphs, layout, the `%` escape | 8.2.2, 8.2.4, 6 |
| `tags.tsv` | Tag pairs and string tokens | 8.1, 7 |
| `comments.tsv` | Both comment styles, and the `[%…]` markup | 5 |
| `variations.tsv` | Recursive annotation variations | 8.2.5 |
| `numbering.tsv` | Where `number` and `side` come from, including the `FEN` tag | 8.2.2, 9.7 |
| `games.tsv` | Whole games, termination markers, multi-game databases | 8, 8.2.6, 18 |
| `strict.tsv` | Import format vs export format, each row twice | 3, 8.2.3.7 |
| `errors.tsv` | Inputs that are not chess notation | — |
| `realworld.tsv` | Whole games as they appear in the wild | — |

## Rules

- **Prefer a fixture here over an in-language assertion** when a case is
  expressible as `input -> JSON`. That is what makes the suite portable.
  The in-language suite (`ts/test/chess.test.ts`) keeps only what a fixture
  cannot express: option handling, error messages, and the exported helpers.
- **Cite the PGN section** in the comment above a group of rows. A fixture
  that pins behaviour nobody can trace to the standard is pinning a guess.
  Where the standard is silent — the `[%…]` comment markup — say so.
- **A rejection is a claim too.** `ERROR` rows are as important as passing
  ones: they are what stops the parser quietly widening. Use
  `ERROR:<substring>` when the *message* is the point (an unterminated
  comment, say), and plain `ERROR` when only the refusal matters.
- **Do not loosen a row to make it pass.** If a fixture goes red, either the
  parser regressed or the fixture was wrong about the standard — find out
  which, and cite the section either way. `games.tsv` has two rows that were
  wrong on the first draft (a bare integer *is* a legal move number
  indication, 8.2.2.1) and were corrected against the spec, not against the
  output.
- **A new fixture must pass before it is committed.** Run `npm test` from
  `ts/`.
