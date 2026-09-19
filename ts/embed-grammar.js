#!/usr/bin/env node

// Embed chess-grammar.jsonic into the TypeScript, Go AND Rust sources.
// Run via: npm run embed  (or:  node embed-grammar.js)
//
// The grammar is AUTHORED in jsonic (so it can carry comments) and
// EMBEDDED as JSON, so each runtime parses it with its own standard
// library and needs no jsonic at run time. @tabnas/jsonic is a
// build-time dependency only.
//
// This is what keeps the two runtimes honest: they do not each have a
// grammar, they have THE grammar.
//
// Never hand-edit between the BEGIN/END markers: edit
// chess-grammar.jsonic and re-run this script.

const fs = require('fs')
const path = require('path')

const { Tabnas } = require('@tabnas/parser')
const { jsonic } = require('@tabnas/jsonic')

const GRAMMAR_FILE = path.join(__dirname, '..', 'chess-grammar.jsonic')
const TS_FILE = path.join(__dirname, 'src', 'chess.ts')
const GO_FILE = path.join(__dirname, '..', 'go', 'chess.go')
const RS_FILE = path.join(__dirname, '..', 'rs', 'src', 'lib.rs')

const BEGIN = '// --- BEGIN EMBEDDED chess-grammar.jsonic ---'
const END = '// --- END EMBEDDED chess-grammar.jsonic ---'

const source = fs.readFileSync(GRAMMAR_FILE, 'utf8')
const grammar = new Tabnas().use(jsonic).parse(source)

if (null == grammar || null == grammar.rule) {
  console.error('Grammar has no `rule` table:', GRAMMAR_FILE)
  process.exit(1)
}

// A ref map is supplied by the plugin at load time, never by the grammar
// data, so an `@name` in the grammar must be a string. Catch a stray
// object early rather than at the first parse.
for (const [name, rule] of Object.entries(grammar.rule)) {
  for (const phase of ['open', 'close']) {
    for (const alt of rule[phase] || []) {
      for (const field of ['a', 'c', 'h', 'e']) {
        const val = alt[field]
        if (null != val && 'string' !== typeof val) {
          console.error(`rule ${name}.${phase}: \`${field}\` must be an @ref string`)
          process.exit(1)
        }
      }
    }
  }
}

const json = JSON.stringify(grammar, null, 2)

function embedTS() {
  let src = fs.readFileSync(TS_FILE, 'utf8')
  const startIdx = src.indexOf(BEGIN)
  const endIdx = src.indexOf(END)
  if (-1 === startIdx || -1 === endIdx) {
    console.error('TS markers not found in', TS_FILE)
    process.exit(1)
  }

  // JSON has no backtick or `${`, so a template literal needs no escaping
  // beyond the backslash JSON itself may emit.
  const escaped = json.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')

  const replacement = BEGIN + '\nconst grammarText = `\n' + escaped + '`\n' + END

  src = src.substring(0, startIdx) + replacement + src.substring(endIdx + END.length)
  fs.writeFileSync(TS_FILE, src)
  console.log('Embedded grammar into', TS_FILE)
}

function embedGo() {
  let src = fs.readFileSync(GO_FILE, 'utf8')
  const startIdx = src.indexOf(BEGIN)
  const endIdx = src.indexOf(END)
  if (-1 === startIdx || -1 === endIdx) {
    console.error('Go markers not found in', GO_FILE)
    process.exit(1)
  }

  // A Go raw string literal cannot contain a backtick and has no escapes,
  // so the JSON goes in verbatim — but only if it holds no backtick.
  if (json.includes('`')) {
    console.error('Grammar contains a backtick, incompatible with Go raw strings')
    process.exit(1)
  }

  // The blank line before END keeps the result gofmt-clean.
  const replacement = BEGIN + '\nconst grammarText = `\n' + json + '`\n\n' + END

  src = src.substring(0, startIdx) + replacement + src.substring(endIdx + END.length)
  fs.writeFileSync(GO_FILE, src)
  console.log('Embedded grammar into', GO_FILE)
}

function embedRust() {
  let src = fs.readFileSync(RS_FILE, 'utf8')
  const startIdx = src.indexOf(BEGIN)
  const endIdx = src.indexOf(END)
  if (-1 === startIdx || -1 === endIdx) {
    console.error('Rust markers not found in', RS_FILE)
    process.exit(1)
  }

  // A Rust raw string has no escapes, so the JSON goes in verbatim. The
  // hash count has to clear the longest `"#...` run the JSON contains,
  // and the JSON is full of `"#SAN"`-style token names, so two hashes is
  // the floor rather than the usual one.
  if (json.includes('"##')) {
    console.error('Grammar contains `"##`, incompatible with the r## raw string')
    process.exit(1)
  }

  const replacement =
    BEGIN + '\nconst GRAMMAR_TEXT: &str = r##"\n' + json + '"##;\n' + END

  src = src.substring(0, startIdx) + replacement + src.substring(endIdx + END.length)
  fs.writeFileSync(RS_FILE, src)
  console.log('Embedded grammar into', RS_FILE)
}

embedTS()
for (const [label, file, embed] of [
  ['Go', GO_FILE, embedGo],
  ['Rust', RS_FILE, embedRust],
]) {
  if (fs.existsSync(file)) {
    embed()
  } else {
    console.log('No', label, 'source at', file, '- skipping')
  }
}
