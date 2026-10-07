# Tabnas Plugin Template Guide

This repository was bootstrapped from the `@tabnas/zon` **template**, the
scaffold Tabnas grammar plugins are copied from. This file is for an agent
*starting a fresh plugin*: it separates the reusable scaffolding from the
format-specific parts, documents the engine model every plugin author
needs, maps the ecosystem so you pick the right base, and lists the
dev-environment realities that aren't obvious from a clone.

Its worked example is ZON, because that is the template's own format.
`@tabnas/chess` is what the *other* branch of §3's decision rule looks
like: a non-JSON-shaped format, built on the bare engine, with a tokenising
lexer rather than a scannerless grammar. For this plugin's own internals
see [`AGENTS.md`](AGENTS.md), and for the reasoning behind them
[`ts/doc/concepts.md`](ts/doc/concepts.md).

> Every engine-behaviour claim below was read off the published
> `@tabnas/parser` source (`dist/defaults.js`, `dist/lexer.js`,
> `dist/rules.js`, `dist/builtins.js`), not folklore. You don't need to
> read `dist/` yourself.

---

## 1. Using this repo as a template

### Reusable — copy as-is, retune lightly

| Piece | What to keep |
|---|---|
| **Dual-runtime layout** | `ts/` is canonical, `go/` tracks it. TS wins on any behaviour disagreement; change Go to match. Drop `go/` entirely if you only want TS. |
| **Single-source grammar + embed** | One `*-grammar.jsonic` at the repo root is the only hand-edited grammar. `ts/embed-grammar.js` copies it verbatim into the `grammarText` literal in **both** `ts/src/<plugin>.ts` and `go/<plugin>.go`, between `// --- BEGIN/END EMBEDDED ... ---` markers. Never hand-edit between the markers; edit the `.jsonic` and run `npm run embed`. The Go embed rejects backticks (Go raw-string limitation). |
| **node:test + dist layout** | Tests are authored in TS under `ts/test/*.test.ts`, compiled to `dist-test/`, run with `node --test "dist-test/*.test.js"`. `src` → `dist`, `test` → `dist-test`. No bundler, no jest. |
| **doc-examples harness** | `ts/test/doc-examples.test.ts` is identical across tabnas repos. It scans markdown, runs ` ```js ` blocks that contain a `// =>` assertion, and checks each `<expr> // => <expected>`. Keep it; your README examples become tests for free. |
| **Diataxis doc set** | `ts/doc/{tutorial,guide,reference,concepts}.md` (+ `go/doc/`). One file per quadrant, per runtime. Rewrite the prose; keep the four-file shape. |
| **Makefile / CI shape** | Root `Makefile` wraps every runtime this repo carries (`build`/`test`/`clean`/`reset`, `tags-go`), one `<name>-ts`/`-go`/`-rs` target per side. `.github/workflows/ci.yml` is a thin caller of the org's reusable `tabnas/.github/.github/workflows/polyglot-ci.yml@main`. The reusable workflow owns the matrix: `ts/` on Linux, macOS and Windows under Node `24.x`, `go/` on Linux and macOS under Go `1.24`. It clones each `deps` repo beside this one, builds it, and uses it in place of the published copy (linked over `node_modules/@tabnas/<name>`, and added to a `go.work`), so a sibling left off the list is used only at its published version. A new plugin passes its sibling closure as `deps`, in dependency-first order: the tabnas packages it declares, and the tabnas repos those depend on in turn. This repo passes `deps: "parser support debug json railroad jsonic"`: `parser`, `debug`, `railroad` and `jsonic` from `ts/package.json`, and `support` and `json`, which those depend on. It needs no `build-order`: the default, `deps` followed by the plugin itself, is right for a plugin nothing else depends on. Reuse the structure; swap the package name. |
| **Release path** | Releases run in CI, never from the `Makefile`. A release PR bumps every version site. Once it is merged and `main` CI is green, a `workflow_dispatch` of `.github/workflows/release.yml` on `main`, with `go` true, publishes to npm over OIDC trusted publishing and pushes the `ts/v*` and `go/v*` tags itself. This repo's `make publish-ts` and `make publish-go` predate that workflow and are not the release path: `publish-ts` publishes over a token, bypassing OIDC, and `publish-go` moves only the Go version site, the state the version tests reject. Leave both out of a new plugin. `AGENTS.md`, "Releasing", has the full sequence. |
| **package.json conventions** | Engine deps (`@tabnas/parser`, and `@tabnas/jsonic`/`@tabnas/abnf` if you base on one) are **`peerDependencies`** at the deliberately open range `">=0"`, so an install resolves the latest published engine, each mirrored as a `"*"` **devDependency**. `@tabnas/debug` and `@tabnas/railroad` are dev-only `"*"` entries, and so is `@tabnas/support` once your tests use the shared fixture runner (this repo's do not). **No `file:` paths**: monorepo wiring lives outside `package.json` (see §4). `engines.node` is `>=24`. |

### ZON-specific — rewrite for your format

These exist because ZON is a JSON-family format layered on jsonic. A
*different* format replaces them wholesale:

- **The jsonic layering.** `new Tabnas().use(jsonic).use(Zon)` and the
  `rule.exclude: 'jsonic,imp'` / fixed-token remaps that disable jsonic
  features ZON doesn't want. Only relevant if you also base on jsonic.
- **The custom lex matchers** `zonDot` / `zonMultiString` / `zonChar` —
  Zig syntax (`.{`, `\\`-prefixed multiline strings, `'x'` char literals)
  the jsonic lexer can't express. Your format needs its *own* matchers (or
  none).
- **The token remaps** — `#CL` → `=` instead of `:`, nulling out bare
  `{` `[` `]`, `KEY: ['#TX']`. These encode ZON's surface syntax.
- **The `enumTag` / `charAsNumber` plugin options** and the `@val-ac`
  enum-rewrap hook.

**If your language is not JSON-family, do not start from the jsonic
layering at all** — see §3.

---

## 2. The tabnas engine model

A plugin is a function `(tn, options) => { ... }` that adds lex matchers
and grammar rules to a `Tabnas` engine. To write one you need the lexer
model and the parse model.

### Lexer — a plain whole-word tokeniser

The lexer walks the source and emits **whole-word tokens**, trying a fixed
list of matchers in ascending `order` until one matches. Defaults
(`dist/defaults.js`, `lex.match`):

| order | matcher | emits |
|---|---|---|
| 1e6 | match | custom token/value matchers (`match.token`) |
| 2e6 | fixed | the fixed punctuation tokens below |
| 3e6 | space | `#SP` |
| 4e6 | line | `#LN` |
| 5e6 | string | `#ST` |
| 6e6 | comment | `#CM` |
| 7e6 | number | `#NR` |
| 8e6 | text | `#TX` bareword, or `#VL` for a keyword value |

**Lower `order` runs first.** A custom matcher registers under
`options.lex.match.<name> = { order, make }`. To own a prefix the
fixed matcher would otherwise grab (as ZON's `zonDot` owns `.`), give it an
`order` below `2e6` — ZON uses `1e5`.

The four value-bearing tokens an alt can match as a `VAL`/`KEY`:

- `#TX` — bareword / identifier (text matcher; `val` = the word)
- `#NR` — number (hex/oct/bin/`_` separators on by default)
- `#ST` — quoted string
- `#VL` — a keyword value: `true`/`false`/`null` (from `value.def`)

Default **fixed tokens** (`fixed.token`): `{`→`#OB`, `}`→`#CB`,
`[`→`#OS`, `]`→`#CS`, `:`→`#CL`, `,`→`#CA`. Remap or null these to
reshape surface syntax (ZON nulls `#OB`/`#OS`/`#CS` and sets `#CL` to `=`).

**Whitespace, newlines and comments are ignored by the parser.** The
lexer still emits `#SP`/`#LN`/`#CM`, but `tokenSet.IGNORE =
['#SP','#LN','#CM']` tells the parser to skip them between meaningful
tokens — so your grammar never mentions whitespace. Two other token sets
matter: `VAL` and `KEY` (both `['#TX','#NR','#ST','#VL']` by default) list
which tokens may stand as a value or a key.

### Parser — rules, alts, and the result value

The parser runs a stack of **rules**. Each rule has an **open** phase and
a **close** phase, each a list of **alts** (alternatives). Parsing starts
at `rule.start` (default `'val'`). An alt is matched against the upcoming
tokens; the first alt whose token pattern matches fires.

**Alt fields** (from `dist/rules.js`):

| field | meaning |
|---|---|
| `s` | token-match sequence — space-separated token names to look ahead for, e.g. `'#OS #CB'`. A `null` position is a wildcard. |
| `p` | **push** a named rule (descend into a child rule) |
| `r` | **replace** the current rule with a named rule (loop / iterate siblings) |
| `b` | **backtrack** N tokens — matched but *not* consumed, so the next rule re-reads them |
| `g` | **group tags**, comma-separated, for `rule.include`/`rule.exclude` filtering |
| `a` | **action** — a function `(rule, ctx, alt)` or a `@named` builtin ref, run when the alt fires |
| `c` | optional condition predicate; `n` counters; `u`/`k` custom props (`k` propagates to children); `e` error |

**Rule lifecycle** (per rule instance):
`before-open (bo)` → match an open alt + `after-open (ao)` → *(push
children via `p`)* → `before-close (bc)` → match a close alt +
`after-close (ac)`. You hook a phase with a reserved handler named
`@<rule>-bo|ao|bc|ac`, optionally suffixed `/prepend`, `/append`, or
`/replace`. `/replace` takes ownership of the phase and suppresses other
handlers on it — a real gotcha when composing plugins (it's why ZON's
enum rewrap runs on `@val-ac`, not `@val-bc`, which jsonic has replaced).

**Result value: `{rule,src,kids}` vs a native value.** By default the
engine's `mkNode` builds a generic parse node `{ rule, src, kids }` (a
CST). But a real plugin builds a **native JS/Go value** by writing
`r.node` in its actions, using the builtins in `dist/builtins.js`:

- `@map$` allocates `r.node = {}`, `@array$` allocates `r.node = []`
- the `pair` rule sets `node[key] = child.node`; the `elem` rule pushes
  `child.node` into the array; `@val$` coalesces a child node or the
  matched token's `val`

The final parse result is the start rule's `r.node`. So "turning a parse
into a value" = wiring actions that allocate a container on open and fold
each child into it on close. ZON reuses jsonic's `val`/`map`/`list`/
`pair`/`elem` machinery and only overrides which tokens open/close them.

### Gotchas that cost time

- **Group tags must match `/^[a-z][a-z0-9-]+$/`** (verified in
  `rules.js`). Note the `+`: a *single* letter is **invalid** — `g: 'a'`
  throws, `g: 'aa'` or `g: 'a1'` is fine.
- **Option injection — the "zon pattern".** Build the grammar object,
  then attach overrides to it so the plugin applies atomically:
  ```js
  const grammarDef = new Tabnas().use(jsonic).parse(grammarText)
  grammarDef.ref = { '@val-ac': (r, ctx) => { /* handler */ } }
  grammarDef.options = {
    rule:   { exclude: '...', start: 'val' },
    fixed:  { token: { '#CL': '=', '#OB': null } },
    string: { /* ... */ },
    lex:    { match: { myMatcher: { order: 1e5, make: buildMyMatcher() } } },
  }
  tn.grammar(grammarDef, { rule: { alt: { g: 'myplugin' } } })
  ```
  Per-plugin scalar options ride on `tn.options({ config: { modify: {...} } })`.
  Tagging every alt with one group (`g: 'myplugin'`) lets callers
  `rule.exclude: 'myplugin'` to turn your plugin off.

---

## 3. Ecosystem map — pick the right base

| Package | Use when |
|---|---|
| **`@tabnas/parser`** | The engine (lexer + rule/alt parser). Everything depends on it; you rarely build directly on the bare engine. |
| **`@tabnas/jsonic`** | Relaxed-JSON grammar plugin. **Base for JSON-family formats** — JSON5-likes, ZON, config dialects with `{}`/`[]`/`key: value` shape. |
| **`@tabnas/abnf`** | Compiles an RFC-5234 **ABNF** grammar into a `GrammarSpec`. **Base for arbitrary / keyword-rich languages.** |
| **`@tabnas/json`** | Strict RFC-8259 JSON. A reference plugin / minimal base. |
| **`@tabnas/debug`** | Introspection + tracing; adds `describe()` and a serialisable model. Dev/test only. |
| **`@tabnas/railroad`** | Renders a railroad/syntax diagram from the live config. Dev/docs only. |

**Decision rule:** if your language is **not** JSON-shaped (a DSL, a
config syntax with keywords, an RFC-defined wire format), author it as an
**ABNF grammar compiled via `@tabnas/abnf`** — do **not** hand-write
jsonic rule alts. Hand-written jsonic layering only pays off for
JSON-family formats that genuinely reuse jsonic's relaxed-JSON behaviour
(as ZON does).

---

## 4. Dev-environment realities

### Two dev layouts, both green — and no `file:` paths

The `@tabnas/*` deps are plain registry ranges (`peerDependencies` at
`">=0"`, mirrored as `"*"` devDependencies — see §1). There are **no
`file:` paths in `package.json`**: nothing in the committed manifest
points at a sibling directory, so both layouts below build without
editing it.

- **Isolated single-repo checkout** — nothing extra to do. `npm install`
  resolves the `"*"` devDependencies from the registry, so the build runs
  against the published `@tabnas/*` packages:

  ```bash
  cd ts
  npm install            # resolves @tabnas/* from the registry, plus typescript + @types/node
  npm test               # builds first (pretest), then node --test over dist-test/*.test.js and test/docs.test.js
  ```

  `pretest` runs `npm run build` (`embed-grammar.js`, then `tsc --build`
  on `src` and `test`), so a separate build step only builds twice.

  Drop `@tabnas/jsonic` from your deps for a non-jsonic plugin; add
  whatever base you actually use.

- **Monorepo (fleet) layout** — every tabnas repo a sibling directory.
  Run the admin repo's **`make link`** (`scripts/link.sh`) after
  installing: it overlays `node_modules/@tabnas` symlinks onto the
  installed packages and generates a `go.work` covering the sibling
  modules, so you build against sibling working trees instead of the
  registry. The link graph is derived from each repo's `ts/package.json`
  and `go/go.mod`, **no tracked file is edited**, and re-running it is
  idempotent. That is where monorepo wiring lives, not in
  `package.json`.

**Go needs nothing extra.** `go/go.mod` `require`s the published modules
directly, with **no `replace` directive**, so
`go build ./... && go test -v ./...` resolves them from the module proxy
in a bare checkout. This repo requires only `github.com/tabnas/parser/go`.
ZON also requires `github.com/tabnas/jsonic/go`, and
`github.com/tabnas/support/go` for its parity test.

No version is given here on purpose. Each require names its module's
**latest published version**, because versions track the latest release
(see `CLAUDE.md`). Add one with `go get <module>@latest` rather than
copying a version from another repo's `go.mod`. From then on, each
release of your plugin moves every tabnas require to that module's
current release, and an engine release reaches each dependent in a
`deps(go)` pull request. The `GOWORK=off` step in CI builds against
exactly the versions `go.mod` names.

### Node engine

`engines.node` is `>=24`, and CI builds and tests on Node `24.x`, the
reusable workflow's default `node-version` (see the CI row in §1), so
the declared floor is the version that is tested. Use Node 24 or later
locally too. On an older Node, npm prints `npm warn EBADENGINE` lines,
and no CI run covers that combination.

### How the doc-examples harness resolves `require()`

In `ts/test/doc-examples.test.ts`, a doc example's `require(spec)`:

- resolves normally from this package's `node_modules` first;
- if that misses, **own package name** (`@tabnas/<this>`) → this repo's
  `ts/` directory (self-reference);
- any other `@tabnas/<x>` → the **sibling** repo `../<x>/ts` (monorepo
  fallback).

Only ` ```js ` / ` ```javascript ` blocks containing a `// =>` line are
executed; blocks with no `// =>` are treated as illustrative and skipped,
and ` ```js ignore ` is excluded explicitly.
</content>
</invoke>
