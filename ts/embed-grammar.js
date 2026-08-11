#!/usr/bin/env node

// Embed chess-grammar.jsonic into the TypeScript source.
// Run via: npm run embed  (or:  node embed-grammar.js)
//
// The grammar is AUTHORED in jsonic (so it can carry comments) and
// EMBEDDED as JSON, so the shipped plugin parses it with JSON.parse and
// needs no jsonic at runtime. @tabnas/jsonic is a build-time dependency
// only.
//
// Never hand-edit between the BEGIN/END markers: edit
// chess-grammar.jsonic and re-run this script.

const fs = require('fs')
const path = require('path')

const { Tabnas } = require('@tabnas/parser')
const { jsonic } = require('@tabnas/jsonic')

const GRAMMAR_FILE = path.join(__dirname, '..', 'chess-grammar.jsonic')
const TS_FILE = path.join(__dirname, 'src', 'chess.ts')

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

embedTS()
