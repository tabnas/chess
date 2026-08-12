/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

/* The package as an installable thing, rather than as source.
 *
 * A component that works perfectly in the browser is still broken if
 * `require()` throws, if `main` points at a file Node cannot parse, or if
 * the tarball is missing the licence. None of that shows up in the engine
 * or element suites, because both of them reach past the package and load
 * files by path. These tests go the way a consumer does: through
 * package.json, through the `exports` map, and through `npm pack`.
 */

const { describe, test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const pkg = require(path.join(ROOT, 'package.json'))

const abs = (p) => path.join(ROOT, p)

/** Every file path mentioned anywhere in an `exports` subtree. */
function targets(node, found = []) {
  if ('string' === typeof node) found.push(node)
  else if (node && 'object' === typeof node) Object.values(node).forEach((v) => targets(v, found))
  return found
}

describe('package entry points', () => {
  test('every exports target exists', () => {
    for (const target of targets(pkg.exports)) {
      if (target.includes('*')) continue
      assert.ok(fs.existsSync(abs(target)), `missing exports target: ${target}`)
    }
  })

  test('every legacy field points at a file that exists', () => {
    for (const field of ['main', 'module', 'types', 'unpkg', 'jsdelivr', 'customElements']) {
      const target = pkg[field]
      assert.ok(target, `package.json has no "${field}"`)
      assert.ok(fs.existsSync(abs(target)), `"${field}": ${target} does not exist`)
    }
  })

  /* Node picks a file's module format from its extension and the nearest
   * package.json "type". An ES module named .js inside a "type":
   * "commonjs" package is a syntax error on `require` AND on `import`,
   * which is a way to publish a package nobody can load. */
  test('the module format of each entry matches its extension', () => {
    const cjs = ['main', ['exports', '.', 'require']]
    const esm = ['module', ['exports', '.', 'import'], ['exports', './engine', 'import']]
    const at = (spec) =>
      Array.isArray(spec) ? spec.slice(1).reduce((o, k) => o[k], pkg[spec[0]]) : pkg[spec]

    for (const spec of cjs) {
      assert.match(at(spec), /\.cjs$/, `${JSON.stringify(spec)} should be a .cjs file`)
    }
    for (const spec of esm) {
      assert.match(at(spec), /\.mjs$/, `${JSON.stringify(spec)} should be an .mjs file`)
    }
  })

  test('"types" comes first in every exports condition', () => {
    for (const [subpath, conditions] of Object.entries(pkg.exports)) {
      if ('string' === typeof conditions) continue
      assert.strictEqual(
        Object.keys(conditions)[0],
        'types',
        `"${subpath}": TypeScript takes the first matching condition, so "types" must lead`,
      )
    }
  })

  test('require() loads the component and registers nothing', () => {
    const m = require(abs(pkg.main))
    assert.strictEqual(typeof m.define, 'function')
    assert.strictEqual(typeof m.ChessGameElement, 'function')
  })

  test('import() loads the component', async () => {
    const m = await import('node:url').then(({ pathToFileURL }) =>
      import(pathToFileURL(abs(pkg.module)).href),
    )
    assert.strictEqual(typeof m.define, 'function')
    assert.strictEqual(typeof m.ChessGameElement, 'function')
  })

  test('the engine subpath loads without a DOM', async () => {
    const m = require(abs(pkg.exports['./engine'].require))
    assert.strictEqual(typeof m.startPosition, 'function')
    assert.strictEqual(m.legalMoves(m.startPosition()).length, 20)
  })
})

describe('declarations', () => {
  const files = ['dist/chess-game.d.ts', 'dist/engine.d.ts']

  test('are shipped', () => {
    for (const f of files) assert.ok(fs.existsSync(abs(f)), `missing ${f}`)
  })

  /* The bundle vendors @tabnas/chess, so the types have to as well: a
   * declaration that imports it would make a zero-dependency package need
   * a dependency to typecheck. */
  test('are self-contained', () => {
    for (const f of files) {
      const text = fs.readFileSync(abs(f), 'utf8')
      const leak = text.match(/^\s*(?:import|export)\b.*\bfrom\s+['"]([^.'"][^'"]*)['"]/m)
      assert.strictEqual(leak, null, `${f} imports ${leak && leak[1]}`)
    }
  })

  test('declare the element for editors', () => {
    const text = fs.readFileSync(abs('dist/chess-game.d.ts'), 'utf8')
    assert.match(text, /interface HTMLElementTagNameMap/)
    assert.match(text, /"chess-game": ChessGameElement/)
  })
})

describe('the published tarball', () => {
  // --ignore-scripts: `prepack` would rebuild, and the build is what put
  // dist/ there in the first place.
  const packed = JSON.parse(
    execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
  )[0]
  const shipped = new Set(packed.files.map((f) => f.path))

  test('contains every entry point', () => {
    const wanted = [
      ...targets(pkg.exports).filter((t) => !t.includes('*')),
      pkg.main,
      pkg.module,
      pkg.types,
      pkg.unpkg,
      pkg.jsdelivr,
      pkg.customElements,
    ]
    for (const f of wanted) {
      assert.ok(shipped.has(f.replace(/^\.\//, '')), `not in the tarball: ${f}`)
    }
  })

  test('contains the licence and the readme', () => {
    assert.ok(shipped.has('LICENSE'), 'LICENSE is listed in "files" but is not in the tarball')
    assert.ok(shipped.has('README.md'))
  })

  test('carries the integrity hashes for the CDN files', () => {
    assert.ok(shipped.has('dist/sri.json'))
    const sri = JSON.parse(fs.readFileSync(abs('dist/sri.json'), 'utf8'))
    assert.strictEqual(sri.version, pkg.version)
    for (const f of ['chess-game.js', 'chess-game.mjs']) {
      assert.match(sri.integrity[f], /^sha384-[A-Za-z0-9+/]{64}$/)
    }
  })
})

/* The manifest is what gives an editor autocomplete for <chess-game> and
 * its attributes, and a hand-written one drifts silently. Check it against
 * the source it describes. */
describe('the custom elements manifest', () => {
  const manifest = JSON.parse(fs.readFileSync(abs('custom-elements.json'), 'utf8'))
  const el = manifest.modules[0].declarations[0]
  const source = (f) => fs.readFileSync(abs(path.join('src', f)), 'utf8')

  test('describes the element this package defines', () => {
    assert.strictEqual(el.tagName, 'chess-game')
    assert.strictEqual(el.name, 'ChessGameElement')
    assert.ok(fs.existsSync(abs(manifest.modules[0].path)))
  })

  test('lists every observed attribute', () => {
    const { ChessGameElement } = require(abs(pkg.main))
    const listed = el.attributes.map((a) => a.name)
    for (const name of ChessGameElement.observedAttributes) {
      assert.ok(listed.includes(name), `observed but undocumented: ${name}`)
    }
    // `theme` is read by the stylesheet rather than by JavaScript, so it
    // is documented without being observed. Anything else is a mistake.
    for (const name of listed) {
      if ('theme' === name) continue
      assert.ok(
        ChessGameElement.observedAttributes.includes(name),
        `documented but not observed: ${name}`,
      )
    }
  })

  test('lists exactly the shadow parts the template exposes', () => {
    const parts = [...source('element.ts').matchAll(/part="([a-z]+)"/g)].map((m) => m[1])
    assert.deepStrictEqual(
      el.cssParts.map((p) => p.name).sort(),
      [...new Set(parts)].sort(),
    )
  })

  test('lists exactly the custom properties the styles define', () => {
    const host = source('style.ts').match(/:host \{([\s\S]*?)\n\}/)[1]
    const tokens = [...host.matchAll(/^\s*(--[a-z-]+)\s*:/gm)].map((m) => m[1])
    assert.deepStrictEqual(
      el.cssProperties.map((p) => p.name).sort(),
      tokens.sort(),
    )
  })
})
