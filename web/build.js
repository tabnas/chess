#!/usr/bin/env node

/* Package <chess-game> for a CDN or a static upload.
 *
 * The output is SELF-CONTAINED: @tabnas/chess and the @tabnas/parser
 * engine underneath it are bundled in, the styles are a string in the
 * source, and the board is inline SVG. One file, no fetches, no assets.
 * That is the whole point of the exercise — a component you can drop on a
 * page with one <script> tag.
 *
 * Three artifacts, because the three ways people consume a component do
 * not overlap:
 *
 *   chess-game.js       IIFE, minified — <script src>, registers the element
 *   chess-game.esm.js   ESM, minified  — import from a bundler or a module
 *   chess-game.dev.js   IIFE, readable, sourcemapped — for debugging
 *
 * Usage: node build.js [--watch] [--serve]
 */

const fs = require('node:fs')
const path = require('node:path')
const esbuild = require('esbuild')

const ROOT = __dirname
const OUT = path.join(ROOT, 'dist')
const ENTRY = path.join(ROOT, 'src', 'index.ts')

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
    entryPoints: [path.join(ROOT, 'src', 'engine.ts')],
    outfile: path.join(OUT, 'engine.cjs'),
    format: 'cjs',
    minify: false,
  },
  {
    ...common,
    outfile: path.join(OUT, 'chess-game.js'),
    format: 'iife',
    globalName: 'ChessGame',
    minify: true,
  },
  {
    ...common,
    outfile: path.join(OUT, 'chess-game.esm.js'),
    format: 'esm',
    minify: true,
  },
  {
    ...common,
    outfile: path.join(OUT, 'chess-game.dev.js'),
    format: 'iife',
    globalName: 'ChessGame',
    minify: false,
    sourcemap: true,
    dev: true,
  },
]

function report() {
  const rows = fs
    .readdirSync(OUT)
    .filter((f) => f.endsWith('.js'))
    .sort()
    .map((f) => {
      const bytes = fs.statSync(path.join(OUT, f)).size
      const gzip = require('node:zlib').gzipSync(fs.readFileSync(path.join(OUT, f))).length
      return [f, kb(bytes), kb(gzip)]
    })

  const width = Math.max(...rows.map((r) => r[0].length))
  console.log('\n  file'.padEnd(width + 4) + '     raw      gzip')
  for (const [file, raw, gz] of rows) {
    console.log('  ' + file.padEnd(width) + raw.padStart(9) + gz.padStart(10))
  }
  console.log()
}

function kb(n) {
  return (n / 1024).toFixed(1) + ' kB'
}

async function main() {
  const watch = process.argv.includes('--watch')
  const serve = process.argv.includes('--serve')

  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(OUT, { recursive: true })

  if (watch || serve) {
    // One readable build while iterating; the minified pair is a release
    // concern and only slows the loop down.
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

  // The demo doubles as the smoke test that the built file really is
  // self-contained: it loads chess-game.js and nothing else. It lives at
  // the repo root so it works straight from a checkout, and is copied
  // into dist/ with the script path rewritten so the built folder is a
  // complete, uploadable site on its own.
  const demo = fs.readFileSync(path.join(ROOT, 'demo.html'), 'utf8')
  fs.writeFileSync(
    path.join(OUT, 'index.html'),
    demo.replace('./dist/chess-game.js', './chess-game.js'),
  )

  report()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
