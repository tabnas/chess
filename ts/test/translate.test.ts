/* Copyright (c) 2026 Richard Rodger, MIT License */

// The translation parts: the manifest and the render a host composes a
// translation from are the package's copies, which npm run embed writes
// into src/translate.ts. They are the only texts a host sees, so these
// hold them to the files.

import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { test } from 'node:test'

// At runtime this file is loaded from `dist-test/`, so `..` is the package
// root: the parts are reached the way a consumer reaches them.
const { translate } = require('..')
const root = path.resolve(__dirname, '..', '..')
const manifest = () =>
  JSON.parse(readFileSync(path.join(root, 'tabnas.plugin.json'), 'utf8'))

test('translation parts expose the manifest, source and explicit entry', () => {
  const parts = translate()
  assert.ok(parts)
  assert.equal(parts.manifest, readFileSync(path.join(root, 'tabnas.plugin.json'), 'utf8'))
  assert.equal(parts.lift, undefined)
  assert.equal(parts.render?.entry, 'pgn-render')
  assert.equal(parts.render?.source, readFileSync(path.join(root, manifest().translate.render), 'utf8'))
})

// An embed takes a plain tree into a format's own schema. PGN's tree is
// the reader's database of games, and a plain tree has no PGN form, so its
// manifest names none and the package carries none; a manifest that named
// one would be held to its file here, as the render is above.
test('translation parts carry the embed the manifest names, and none where it names none', () => {
  const parts = translate()
  const spec = manifest().translate
  if (null == spec.embed) {
    assert.equal(parts.embed, undefined)
  } else {
    assert.equal(parts.embed?.entry, 'pgn-embed')
    assert.equal(parts.embed?.source, readFileSync(path.join(root, spec.embed), 'utf8'))
  }
})

test('PGN reads and writes its own tree, and its loss lines are sentences', () => {
  const m = manifest()
  assert.equal(m.languageId, 'pgn')
  const spec = m.translate
  assert.equal(spec.reads, 'tree')
  assert.equal(spec.writes, 'tree')
  assert.equal(spec.root, 'array')
  assert.equal(spec.schema, 'pgn-database')
  assert.equal(spec.lift, undefined)
  assert.ok(Array.isArray(spec.loss) && 0 < spec.loss.length)
  for (const line of spec.loss) {
    assert.match(line, /^[A-Z].*\.$/s, `${JSON.stringify(line)} is not a sentence`)
  }
})
