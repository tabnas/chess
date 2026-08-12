# Concepts

Why `@tabnas/chess` is built the way it is. For the API see
[reference.md](reference.md).

Two decisions shape everything else: **where the notation is taken apart**
(lexer or grammar), and **what shape the parse comes back in**. The second
is the one you will live with, so it comes first.

---

## 1. The data structure

### What a notation parser can honestly return

A chess move means two different things depending on what you know.

To a chess *engine*, `Nf3` is a transition: a knight moves from g1 to f3.
That reading needs the board. `chess.js` returns
`{ color, from, to, flags, piece, san }`, and `python-chess` returns
`Move(from_square, to_square, promotion)` — both can fill in `from` because
both generate the legal moves of the current position first and match the
notation against them. `python-chess` is explicit that this is a
position-dependent operation: `parse_san` raises `IllegalMoveError` and
`AmbiguousMoveError`, neither of which is a *syntax* error.

To a *parser*, `Nf3` is a string with structure: a piece letter and a
destination square, and no origin. There is no board, so there is no `from`.

Everything below follows from taking that seriously. **The model says what
the notation said, and nothing else.** No field is inferred from chess rules;
`disambiguation` holds as much of the origin square as was written, and where
nothing was written, nothing is there. A consumer that wants the engine
reading can compute it — the reverse, recovering what was actually on the
page from a resolved move, is impossible.

### The shapes on offer

Four models are in circulation for board-free chess notation:

**A flat token list** — `[{type:'move'}, {type:'nag'}, …]`. Faithful and
trivial to produce, but every consumer has to reassemble variations from
parenthesis events, and every consumer does it slightly differently.

**A concrete syntax tree** — the engine's own `{rule, src, kids}`. Complete,
and useless without a second pass; the interesting content sits three
levels down under rules named after grammar bookkeeping.

**A linked game tree with node ids** — `kokopu` and editor-oriented
libraries do this, because an editor needs to insert and delete nodes.
Excellent for that, but it is a graph: it does not serialise to JSON without
a scheme for the links, and it is more machinery than a reader needs.

**A move-centric tree** — a list of moves, each carrying its own
annotations and its own variations. `@mliebelt/pgn-parser` (the widely used
board-free JS parser), `cm-pgn`, `chess.js`'s history and `python-chess`'s
`GameNode` all converge on it, from independent starting points.

This library uses the fourth, for three reasons: it is what consumers
already expect; it maps one-to-one onto the PGN grammar (an
`<element-sequence>` with `<recursive-variation>`s, section 18); and it is
plain JSON, so it crosses a process, a language runtime, or a wire without
ceremony.

### Where this model differs from the prior art

`@mliebelt/pgn-parser`'s move is the closest comparison, and the differences
are deliberate:

| | `@mliebelt/pgn-parser` | here |
|---|---|---|
| piece | `notation.fig` | `piece` |
| capture | `notation.strike` | `capture` |
| destination | `notation.col` + `notation.row` | `to: 'd5'` |
| origin hint | `notation.disc` | `disambiguation: { file, rank }` |
| variations | `PgnMove[][]` | `Line[]` |
| comments | `commentMove` + `commentAfter` + `commentDiag` | `comments: Comment[]` |
| nesting | `move.notation.*` | flat on the move |

1. **The PGN standard's own words.** `fig`, `strike`, `disc`, `col`, `row`
   are a private vocabulary; section 8.2.3 already names these things piece,
   capture, disambiguation, file and rank. Using the standard's terms means
   the field names and the specification are searchable against each other.

2. **A square is one value.** `col: 'd'` + `row: '5'` splits an atom that
   every other chess API (and every chess player) treats as whole. `to:
   'd5'` is what you pass on, index by, and print.

3. **`disambiguation`, not `from`.** Naming a partial origin `from` invites
   the reader to treat it as chess.js's resolved `from` and be wrong for
   every move that needed no disambiguation. The spec's own word for it
   carries the "this is only a hint" meaning in the name.

4. **One comment list.** Three comment fields force every consumer to
   remember which is which, and the structured `[%…]` markup is not a
   different *kind* of comment — it is content inside one. Here a comment is
   `{ kind, text, commands? }`: `text` is always the body verbatim, and
   `commands` is additive.

5. **A variation is a line, not an array.** `Line[]` rather than `Move[][]`
   costs one `.moves` on access and buys something worth more: a variation
   and a game become the *same type*, so one recursive walk handles both,
   and a comment before a variation's first move has somewhere to live
   instead of being dropped or mis-attached.

6. **Flat fields.** There is no `notation` sub-object. A move has ten
   possible fields; nesting six of them under a key named after the thing
   you already have is indirection without a payoff.

### Nothing is lost

The model is lossless with respect to the notation, which is what makes the
round-trip in [guide.md](guide.md#write-notation-back-out) short: `san` is
the move verbatim, comment `text` keeps its markup and whitespace, glyphs
keep their numbers, suffix annotations keep their exact spelling, and
variations keep their nesting. What is *not* preserved is layout — line
breaks and spacing between tokens — because the standard says layout carries
no meaning (8.2.1).

### Where an annotation belongs

A comment, glyph or variation attaches to **the move it follows**. That is
the reading chess writers intend (`1. e4 {Best by test}` is about `e4`) and
the one every other library takes.

The awkward case is an annotation with no move before it — a foreword before
the first move, or `1. e4 ({a note})`. Dropping it would break losslessness
and mis-attaching it would be a lie, so a `Line` carries `comments`, `nags`
and `variations` of its own for exactly this: annotations of the *starting
position* rather than of a move. The fields are otherwise absent, so the
common case does not pay for the rare one.

The genuine limitation: in `1. e4 {after} {before} e5` both comments attach
to `e4`, because the notation gives a parser no way to tell them apart.

### `number` and `side` are counted, not guessed

PGN does not require move numbers, and export format deliberately omits the
number before most Black moves (8.2.2.2). A reader still wants to know where
a move sits, so the parser counts: play alternates from the starting side,
a written move number resynchronises the count, and `...` versus `.`
resynchronises the side.

The starting point comes from the `FEN` tag where there is one — section 9.7
says that tag is how a game declares it does not begin from the initial
array, and fields 2 and 6 of a FEN record are the active colour and the
fullmove number. A game that starts at move 12 with Black to move reports
`number: 12, side: 'b'` for its first move. An absent or unreadable tag falls
back to move 1, White.

This is bookkeeping, not chess: it never consults the position. Inside a
variation the count starts from the move being *replaced*, because that is
what a variation is (8.2.5) — `1. e4 e5 (1... c5)` gives the `c5` number 1,
side `b`.

### Raw tag values

Tag values stay strings. `@mliebelt/pgn-types` parses `Date` into
`{value, year, month, day}` and `TimeControl` into
`{kind, moves, seconds, increment}`, which is convenient right up to the
first `"1992.??.??"` — a spelling section 9.5 explicitly blesses — or the
first tag whose value your program cares about and the parser has never
heard of.

Tag *semantics* are a layer above tag *syntax*, and mixing them makes the
parser's output depend on a table of tag names that the standard itself
calls open-ended (section 9). So `tags` is `Record<string, string>`, in file
order, escapes decoded, and nothing else.

The one exception is `FEN`, read for the starting move number and side —
and even there the tag's value is handed on unchanged.

---

## 2. The grammar

### Chess notation is tokenised, not scannerless

The obvious way to write this grammar is scannerless, one character at a
time, which is what ABNF gives you:

```abnf
san-move    = [ piece ] [ disambig ] [ capture ] square [ promotion ] [ check ]
```

It does not work, for two independent reasons.

**Whitespace is load-bearing.** The tabnas lexer skips whitespace between
tokens, so a character-level rule never sees it — and `Nb1 d2` (two moves)
would parse identically to `Nb1d2` (one disambiguated move). The space is
the *only* thing distinguishing them, and a scannerless grammar has already
thrown it away.

**The move grammar is not LL(1).** `[ disambiguation ] destination` cannot
be decided left to right: in `e4` the `e4` is the destination, in `exd5` the
`e` was a disambiguation, and you cannot tell which until three characters
later. The engine does not backtrack, so the grammar would have to be
hand-factored into something unrecognisable as chess notation.

Both problems vanish once you notice the PGN standard has already answered
the question: section 7 classifies a SAN move as a **symbol token** — one
contiguous, self-delimiting run of characters. So a move is lexed whole, by
one regular expression, and the grammar handles only what is actually
recursive: games, tag pairs, variations.

That split — regular things in the lexer, recursive things in the grammar —
is what the engine is built for, and it is why the whole grammar is
[nine short rules](../../chess-grammar.jsonic).

### The move regex is also the decomposer

The same regular expression that lexes a SAN token takes it apart: its
named groups (`piece`, `dfile`, `drank`, `pcapture`, `pto`, …) are read
straight into the `Move`. There is no second pattern to keep in step, so
the token boundary and the field values cannot disagree about what the move
was.

`strict` mode builds a second, narrower regex from the same template
(section 3's export format), so the two dialects cannot drift either.

### The lexer is directed by the grammar

Tabnas gates a custom match-token matcher on the token columns the active
alternates declare: a matcher only runs where some alternate says it could
match. That gives context-sensitive lexing for free — `Event` is a tag name
inside `[…]` and a lex error in the movetext, with no grammar contortions.

The cost is that **every alternate must name the tokens it expects**,
including the ones it only wants to hand back to its parent. That is why the
grammar is full of `{ s: '#EEND' b: 1 }`: the rule is declaring "I might see
a result marker here, and if I do, I am done with it" so that the lexer will
even try.

Three matchers are registered outside that mechanism, in the `lex.match`
registry, because they are *not* context-sensitive: `{`, `;` and a
first-column `%` mean the same thing wherever they appear. Being
hand-written also lets them keep the row and column counters honest across a
comment that spans lines, so a parse error later in the file still names the
right place.

### PGN comments are content, not whitespace

The engine has a comment matcher, and comments it produces land in the
`IGNORE` token set — the parser never sees them. That is right for a
programming language and wrong here: `{Best by test.}` is the reason the
file exists.

So the engine's comment lexing is switched off entirely, and PGN's two
comment styles are ordinary tokens (`#CMT`, `#RMK`) that the grammar keeps.
The only thing genuinely discarded is the section 6 escape mechanism — a
first-column `%` — which the standard defines as ignorable by exactly this
kind of software. It is lexed as `#CM` and therefore dropped, which is the
one case where the engine's default is what PGN wants.

### `[%clk …]` markup

The `[%name arg,arg]` convention inside comments is not in the standard at
all — it comes from ChessBase and is now emitted by lichess and chess.com on
essentially every game with a clock. Ignoring it would make the parser
useless on the largest corpus of PGN in existence.

It is parsed into `Comment.commands`, and the comment text keeps the markup
verbatim, so the extension is purely additive: a consumer that has never
heard of it sees the same `text` it always did. `commands: false` turns the
parsing off.

### Where a game ends

Section 8.2.6 says each movetext section has exactly one termination marker,
but import-format files often omit it, so "the marker" cannot be the only
signal. The grammar therefore ends a game at a termination marker **or** at
a tag pair, because a tag section only ever precedes its own movetext — a
`[` after the moves have started belongs to the next game.

That rule is enforced by a condition on one alternate rather than by
whitespace: blank lines between games are a layout convention (8.2.1), not
grammar, and a file that omits them still parses correctly.

---

## 3. Trade-offs

- **No board means no legality.** `1. Qh8` parses; `1. e9` does not. The
  first is a well-formed move that may be impossible, the second is not a
  move. A parser can only judge the second, and pretending otherwise would
  mean shipping a chess engine in a grammar plugin.

- **Import format is the default.** Real files are hand-edited, so the
  parser reads what people write. `strict: true` is there for validating
  your own output, where laxness would hide a bug.

- **Non-standard tokens are refused.** `--` and `Z0` (null moves) and `(=)`
  (a draw offer) appear in some tools' output and are in no version of the
  standard. Accepting them would mean either a `Move` with no piece, or a
  quiet lie about what was played. A clear parse error is the better
  failure.

- **One regex per dialect, not a table.** The SAN pattern is built by string
  concatenation from a template. That is less pretty than a rule table and
  much easier to check against section 8.2.3 line by line, which is the
  property that matters for a spec-conformance job.

---

## 4. Two runtimes, one grammar

The TypeScript and Go packages are not two parsers that happen to agree.
The grammar is authored once, in
[`chess-grammar.jsonic`](../../chess-grammar.jsonic), and compiled into
both sources as JSON at build time — so neither runtime can quietly grow a
rule the other lacks. The conformance fixtures in
[`test/spec/`](../../test/spec/) are shared the same way: both runners list
that directory and run every `.tsv` in it, comparing after a JSON
round-trip so the assertion is about the shape a *consumer* receives, not
about either language's internals.

What is necessarily per-runtime is the lexer, because a lexer is code:

- Go's RE2 has no lookahead, so the section 7 symbol-tail rule that stops
  `e2e4` becoming two moves is a bounds check after the match rather than a
  `(?!…)` inside the pattern. Same rule, checked one step later.
- A Go slice is a value, so the rule that appends each game writes through
  a `*Database`, where JavaScript pushes onto an array.
- `Game` embeds `Line` anonymously rather than extending it, which is what
  makes the two marshal to the same JSON object.

None of those is visible in the output — which is the point, and what the
shared fixtures exist to keep true. TypeScript is canonical: where the two
disagree, TS is right and Go is the bug.
