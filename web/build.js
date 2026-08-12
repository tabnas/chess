#!/usr/bin/env node

/* Package <chess-view> for a CDN, an npm install, or a static upload.
 *
 * The output is SELF-CONTAINED: @tabnas/chess and the @tabnas/parser
 * engine underneath it are bundled in, the styles are a string in the
 * source, and the board is inline SVG. One file, no fetches, no assets,
 * and — see the declarations below — no dependencies to install either.
 * That is the whole point of the exercise: a component you can drop on a
 * page with one <script> tag.
 *
 * Five artifacts, because the ways people consume a component do not
 * overlap, and a package that guesses wrong is a package that will not
 * load at all:
 *
 *   chess-view.js       IIFE, minified — <script src>, registers the element
 *   chess-view.mjs      ESM, minified  — `import`, and bundlers
 *   chess-view.cjs      CJS, minified  — `require`
 *   chess-view.dev.js   IIFE, readable, sourcemapped — for debugging
 *   engine.cjs/.mjs     the replay half, for use with no DOM
 *
 * The extensions are load-bearing. Node decides a file's module format
 * from its extension and the nearest package.json `type`, so an ES module
 * named .js inside a "type": "commonjs" package is a syntax error on both
 * `require` and `import`. .mjs and .cjs say it outright.
 *
 * Usage: node build.js [--watch] [--serve]
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const zlib = require('node:zlib')
const esbuild = require('esbuild')

const ROOT = __dirname
const OUT = path.join(ROOT, 'dist')
const ENTRY = path.join(ROOT, 'src', 'index.ts')
const ENGINE = path.join(ROOT, 'src', 'engine.ts')

const pkg = require(path.join(ROOT, 'package.json'))

const BANNER = `/*! ${pkg.name} ${pkg.version} | MIT | ${pkg.homepage}
 * Bundles @tabnas/chess and @tabnas/parser. No external requests. */`

/** @type {import('esbuild').BuildOptions} */
const common = {
  entryPoints: [ENTRY],
  bundle: true,
  target: ['es2022'],
  charset: 'utf8',
  legalComments: 'none',
  banner: { js: BANNER },
  logLevel: 'info',
  // Nothing is external: an unbundled dependency would mean a second
  // request, and a CDN drop-in cannot ask the page for one.
  external: [],
}

const BUILDS = [
  {
    // The engine on its own, for tests and for anyone who wants to replay
    // a game without a DOM. Not minified: it is read, not shipped.
    ...common,
    entryPoints: [ENGINE],
    outfile: path.join(OUT, 'engine.cjs'),
    format: 'cjs',
    minify: false,
  },
  {
    ...common,
    entryPoints: [ENGINE],
    outfile: path.join(OUT, 'engine.mjs'),
    format: 'esm',
    minify: false,
  },
  {
    ...common,
    outfile: path.join(OUT, 'chess-view.js'),
    format: 'iife',
    globalName: 'ChessView',
    minify: true,
  },
  {
    ...common,
    outfile: path.join(OUT, 'chess-view.mjs'),
    format: 'esm',
    minify: true,
  },
  {
    ...common,
    outfile: path.join(OUT, 'chess-view.cjs'),
    format: 'cjs',
    minify: true,
  },
  {
    ...common,
    outfile: path.join(OUT, 'chess-view.dev.js'),
    format: 'iife',
    globalName: 'ChessView',
    minify: false,
    sourcemap: true,
    dev: true,
  },
]

/* The types are bundled for the same reason the code is. `el.move` is a
 * `Move` from @tabnas/chess, and a declaration file that says so by
 * importing it would make a zero-dependency package need a dependency —
 * to typecheck, not to run. dts-bundle-generator inlines every type the
 * public surface reaches, so the .d.ts stands alone like the .js does.
 *
 * One bundle per call, deliberately. A single call shares one program
 * across the entries, and `declare global` is program-wide: the element's
 * HTMLElementTagNameMap augmentation lands in engine.d.ts too, which then
 * names a class engine.d.ts does not declare.
 */
function declarations() {
  const { generateDtsBundle } = require('dts-bundle-generator')

  const entries = [
    // The element's entry carries the global augmentation, so its own
    // `declare global` has to survive the bundling.
    { filePath: ENTRY, outfile: 'chess-view.d.ts', globals: true },
    { filePath: ENGINE, outfile: 'engine.d.ts', globals: false },
  ]

  for (const e of entries) {
    const [bundle] = generateDtsBundle(
      [{ filePath: e.filePath, output: { noBanner: true, inlineDeclareGlobals: e.globals } }],
      { preferredConfigPath: path.join(ROOT, 'tsconfig.json') },
    )
    fs.writeFileSync(path.join(OUT, e.outfile), `${BANNER}\n\n${bundle}`)
  }

  // A declaration that still imports something has failed at its one job.
  for (const e of entries) {
    const text = fs.readFileSync(path.join(OUT, e.outfile), 'utf8')
    const leak = text.match(/^\s*(?:import|export)\b.*\bfrom\s+['"]([^.'"][^'"]*)['"]/m)
    if (leak) throw new Error(`${e.outfile} is not self-contained: it imports '${leak[1]}'`)
  }

  // And one that does not typecheck is worse than none at all, because it
  // fails in the consumer's build rather than in ours. Check it here.
  const files = entries.map((e) => path.join(OUT, e.outfile))
  const tsc = require('node:child_process').spawnSync(
    process.execPath,
    // --ignoreConfig: these files, not the project tsconfig.json, which
    // covers src/ and would not check the generated output at all.
    [require.resolve('typescript/bin/tsc'), '--ignoreConfig', '--noEmit', '--strict',
      '--target', 'es2022', '--lib', 'es2022,dom,dom.iterable', ...files],
    { encoding: 'utf8' },
  )
  if (0 !== tsc.status) throw new Error(`generated declarations do not typecheck:\n${tsc.stdout}`)
}

/* Subresource Integrity hashes for the files a CDN will serve. A pinned
 * URL says which version you got; the hash says nothing changed on the
 * way. Written into dist/ so they ship with the release they describe:
 * the hashes for 1.2.3 are at .../@tabnas/chess-view@1.2.3/dist/sri.json.
 */
function integrity(files) {
  const sri = {}
  for (const f of files) {
    const hash = crypto.createHash('sha384').update(fs.readFileSync(path.join(OUT, f))).digest()
    sri[f] = `sha384-${hash.toString('base64')}`
  }
  fs.writeFileSync(
    path.join(OUT, 'sri.json'),
    JSON.stringify({ name: pkg.name, version: pkg.version, integrity: sri }, null, 2) + '\n',
  )
  return sri
}

function report(sri) {
  const rows = fs
    .readdirSync(OUT)
    .filter((f) => /\.(js|mjs|cjs)$/.test(f))
    .sort()
    .map((f) => {
      const bytes = fs.statSync(path.join(OUT, f)).size
      const gzip = zlib.gzipSync(fs.readFileSync(path.join(OUT, f))).length
      return [f, kb(bytes), kb(gzip)]
    })

  const width = Math.max(...rows.map((r) => r[0].length))
  console.log('\n  file'.padEnd(width + 4) + '     raw      gzip')
  for (const [file, raw, gz] of rows) {
    console.log('  ' + file.padEnd(width) + raw.padStart(9) + gz.padStart(10))
  }
  console.log('\n  subresource integrity:')
  for (const [file, hash] of Object.entries(sri)) {
    console.log(`  ${file.padEnd(width)}  ${hash}`)
  }
  console.log()
}

function kb(n) {
  return (n / 1024).toFixed(1) + ' kB'
}

/* The railroad diagram, inlined into the page at build time rather than
 * pasted into it.
 *
 * It is generated from the live grammar by @tabnas/railroad (`make
 * diagram`), so a copy sitting in demo.html would be a copy that goes
 * quietly out of date the first time a rule changes. Inlining also keeps
 * the page's promise: one document, one script, no other requests.
 */
function diagram() {
  const svg = path.join(ROOT, '..', 'ts', 'doc', 'grammar.svg')
  if (!fs.existsSync(svg)) {
    // A checkout without the generated diagram still builds a working page.
    console.warn(`  note: ${path.relative(ROOT, svg)} is missing; linking to it instead`)
    return '<p><a href="https://github.com/tabnas/chess/blob/main/ts/doc/grammar.svg">' +
      'Railroad diagram</a></p>'
  }
  return fs.readFileSync(svg, 'utf8').trim()
}

async function main() {
  const watch = process.argv.includes('--watch')
  const serve = process.argv.includes('--serve')

  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(OUT, { recursive: true })

  if (watch || serve) {
    // One readable build while iterating; the rest are a release concern
    // and only slow the loop down.
    const { dev, ...options } = BUILDS.find((b) => b.dev)
    void dev
    const ctx = await esbuild.context(options)
    await ctx.watch()
    if (serve) {
      const { host, port } = await ctx.serve({ servedir: ROOT, port: 8000 })
      console.log(`\n  demo: http://${'0.0.0.0' === host ? 'localhost' : host}:${port}/demo.html\n`)
    }
    return
  }

  for (const build of BUILDS) {
    const { dev, ...options } = build
    void dev
    await esbuild.build(options)
  }

  declarations()

  // The demo doubles as the smoke test that the built file really is
  // self-contained: it loads chess-view.js and nothing else. It lives at
  // the repo root so it works straight from a checkout, and is copied
  // into dist/ with the script path rewritten so the built folder is a
  // complete, uploadable site on its own.
  const demo = fs.readFileSync(path.join(ROOT, 'demo.html'), 'utf8')
  fs.writeFileSync(
    path.join(OUT, 'index.html'),
    demo.replace('./dist/chess-view.js', './chess-view.js').replace('<!--GRAMMAR-SVG-->', diagram()),
  )

  report(integrity(['chess-view.js', 'chess-view.mjs', 'chess-view.dev.js']))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
