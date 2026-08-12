/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

/* The component, in a real browser, loaded the way a page loads it.
 *
 * This is the test the engine tests cannot be: it runs `dist/chess-view.js`
 * through a browser's own custom-element upgrade, shadow DOM, SVG layout
 * and event handling. It also checks the claim the build makes — that the
 * file is self-contained — by counting the network requests the page
 * makes. Exactly two: the page, and the component.
 *
 * SKIPS when playwright-core or a Chromium binary is absent, so `npm test`
 * still runs the engine suite on a machine without a browser. It never
 * silently passes: a skip is reported as one.
 */

const { after, before, describe, test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const DEMO = 'file://' + path.join(__dirname, '..', 'dist', 'index.html')

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers'
  if (!fs.existsSync(root)) return null
  for (const dir of fs.readdirSync(root)) {
    if (!dir.startsWith('chromium-')) continue
    const exe = path.join(root, dir, 'chrome-linux', 'chrome')
    if (fs.existsSync(exe)) return exe
  }
  return null
}

let chromium = null
try {
  chromium = require('playwright-core').chromium
} catch {
  /* not installed */
}

const executablePath = chromium ? findChromium() : null
const skip = !chromium
  ? 'playwright-core is not installed'
  : !executablePath
    ? 'no Chromium binary (set CHROMIUM_PATH)'
    : false

describe('<chess-view> in a browser', { skip }, () => {
  let browser
  let page
  const requests = []
  const errors = []

  before(async () => {
    browser = await chromium.launch({ executablePath })
    page = await browser.newPage()
    page.on('request', (r) => requests.push(r.url()))
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => {
      if ('error' === m.type()) errors.push(m.text())
    })
    await page.goto(DEMO)
    await page.waitForFunction(() => !!customElements.get('chess-view'))
    await page.waitForTimeout(200)
  })

  after(async () => {
    await browser?.close()
  })

  test('the page loads with no errors', () => {
    assert.deepStrictEqual(errors, [])
  })

  test('the bundle is self-contained: the page and the script, nothing else', () => {
    const fetched = requests.map((u) => u.split('/').pop())
    assert.deepStrictEqual(fetched, ['index.html', 'chess-view.js'])
  })

  test('every example on the page upgraded and drew a board', async () => {
    const count = await page.locator('chess-view').count()
    assert.ok(4 <= count, `expected several examples, got ${count}`)
    for (let i = 0; i < count; i++) {
      const squares = await page.locator('chess-view').nth(i).locator('rect.sq').count()
      assert.strictEqual(squares, 64, `example ${i} should have 64 squares`)
    }
  })

  test('the starting position has 32 pieces on it', async () => {
    const game = page.locator('#game-fischer')
    assert.strictEqual(await game.locator('text.pc').count(), 32)
  })

  test('stepping forward plays the move and marks it', async () => {
    const game = page.locator('#game-fischer')
    await game.locator('#first').click()
    await game.locator('#next').click()

    assert.strictEqual(await game.locator('.mv.on').textContent(), 'e4')
    assert.match(await game.locator('.ply').textContent(), /^1 \/ /)
    // e2 vacated, e4 occupied: two marked squares, one for each.
    assert.strictEqual(await game.locator('rect.hl').count(), 2)
  })

  test('stepping back returns to the starting position', async () => {
    const game = page.locator('#game-fischer')
    await game.locator('#prev').click()
    assert.strictEqual(await game.locator('.mv.on').count(), 0)
    assert.strictEqual(await game.locator('.ply').textContent(), '0 / 85')
  })

  test('the arrow keys step too', async () => {
    const game = page.locator('#game-fischer')
    // Focus the host itself. Clicking it would land in the notation panel
    // and jump to whichever move happened to be under the pointer.
    await game.evaluate((el) => el.focus())
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    assert.strictEqual(await game.locator('.mv.on').textContent(), 'e5')
    await page.keyboard.press('Home')
    assert.strictEqual(await game.locator('.mv.on').count(), 0)
  })

  test('clicking a move jumps to it and fires chess-move', async () => {
    const game = page.locator('#game-fischer')
    const seen = page.evaluate(
      () =>
        new Promise((resolve) => {
          document.addEventListener('chess-move', (e) => resolve(e.detail.move.san), {
            once: true,
          })
        }),
    )
    await game.locator('.mv', { hasText: 'Nf3' }).first().click()
    assert.strictEqual(await seen, 'Nf3')
    assert.strictEqual(await game.locator('.mv.on').textContent(), 'Nf3')
  })

  test('the end of the game is the position after the last move', async () => {
    const game = page.locator('#game-fischer')
    await game.locator('#last').click()
    assert.strictEqual(await game.locator('.ply').textContent(), '85 / 85')
    // The Fischer-Spassky ending, agreed drawn after 43. Re6: rook, king
    // and three pawns against bishop, knight, king and three pawns.
    assert.strictEqual(await game.locator('text.pc').count(), 11)
  })

  test('flipping swaps which corner a1 is in', async () => {
    const game = page.locator('#game-fischer')
    const first = () => game.locator('text.co.file').first().textContent()
    assert.strictEqual(await first(), 'a')
    await game.locator('#flip').click()
    assert.strictEqual(await first(), 'h')
    await game.locator('#flip').click()
    assert.strictEqual(await first(), 'a')
  })

  test('orientation="black" starts flipped', async () => {
    const game = page.locator('#game-immortal')
    assert.strictEqual(await game.locator('text.co.file').first().textContent(), 'h')
  })

  test('a variation is navigable, and ⏮ leaves it', async () => {
    const game = page.locator('#game-immortal')
    const inVariation = game.locator('.var .mv').first()
    await inVariation.click()
    assert.strictEqual(await game.locator('.mv.on').textContent(), 'd6')
    // Inside the variation, the count is the variation's.
    assert.strictEqual(await game.locator('.ply').textContent(), '1 / 2')

    await game.locator('#first').click()
    await game.locator('#last').click()
    // Back on the mainline: 45 plies, ending in mate.
    assert.strictEqual(await game.locator('.ply').textContent(), '45 / 45')
    assert.strictEqual(await game.locator('rect.hl.check').count(), 1)
  })

  test('a move that is legal notation but not a legal move is flagged', async () => {
    const game = page.locator('#game-illegal')
    assert.strictEqual(await game.locator('.mv.bad').textContent(), 'Qxh8')
    assert.match(await game.locator('.note.bad').textContent(), /not a legal move/)
  })

  test('changing the text content reloads the game', async () => {
    await page.evaluate(() => {
      const el = document.createElement('chess-view')
      el.id = 'made-in-js'
      el.textContent = '1. d4 d5 2. c4 *'
      document.body.append(el)
    })
    const game = page.locator('#made-in-js')
    await game.locator('#last').waitFor()
    assert.strictEqual(await game.locator('.ply').textContent(), '0 / 3')

    await page.evaluate(() => {
      document.getElementById('made-in-js').textContent = '1. e4 *'
    })
    await page.waitForTimeout(100)
    assert.strictEqual(await game.locator('.ply').textContent(), '0 / 1')
  })

  /* Error messages. The grammar supplies the chess vocabulary; the
   * component adds the position, widens the single character the lexer
   * stopped on to the whole word, and names a bracket left open. None of
   * it is any use if a terminal escape code comes along for the ride. */

  test('an error names the notation and where it is, with no escape codes', async () => {
    const note = await page.evaluate(async () => {
      const el = document.createElement('chess-view')
      el.textContent = '1. e4 zz'
      document.body.append(el)
      await new Promise((r) => setTimeout(r, 50))
      const text = el.shadowRoot.querySelector('.note.bad').textContent
      el.remove()
      return text
    })
    // The escape character itself, not the bracket that follows it in a
    // CSI sequence: `[` is ordinary text and would pass for the wrong reason.
    assert.ok(!note.includes('\u001b'), 'an ANSI escape reached the page')
    assert.doesNotMatch(note, /\[tabnas\//, 'the engine error code reached the page')
    assert.strictEqual(note, '“zz” is not chess notation — line 1, column 7.')
  })

  test('notation that runs out names the bracket left open', async () => {
    const notes = await page.evaluate(async () => {
      const out = []
      for (const src of ['1. e4 (e5', '1. e4 {oops', '[Event "x" 1. e4 *']) {
        const el = document.createElement('chess-view')
        el.textContent = src
        document.body.append(el)
        await new Promise((r) => setTimeout(r, 50))
        out.push(el.shadowRoot.querySelector('.note.bad').textContent)
        el.remove()
      }
      return out
    })
    assert.strictEqual(
      notes[0],
      'The notation ends before the variation opened at line 1, column 7 is closed.',
    )
    assert.strictEqual(notes[1], 'This comment is never closed — line 1, column 7.')
    // Stopped on a real token, but the tag is the actual mistake.
    assert.match(notes[2], /^“1\.” is not chess notation — line 1, column 12\./)
    assert.match(notes[2], /The tag opened at line 1, column 1 is still open\.$/)
  })

  /* Commentary. The supplement asks presentation software to strip command
   * markup before display; these check that it is stripped from the prose
   * and shown as a chip instead, and that the panel mode does not put the
   * same commentary on screen twice. */

  test('command markup is stripped from the prose and shown as a chip', async () => {
    const game = page.locator('#game-blitz')
    await game.locator('.mv').first().waitFor()

    const prose = await game.locator('.cm').allTextContents()
    for (const text of prose) assert.doesNotMatch(text, /\[%/, 'command markup reached the display')
    assert.deepStrictEqual(prose.map((t) => t.trim()).filter(Boolean), ['Book.'])

    // clk and eval are shown; the rest of a comment's commands are not.
    const chips = await game.locator('.cmd').allTextContents()
    assert.ok(chips.includes('0:03:00'), `expected a clock chip, got ${JSON.stringify(chips)}`)
    assert.ok(chips.includes('0.17'), 'expected an evaluation chip')
  })

  test('commentary="panel" moves the prose out of the move list', async () => {
    const game = page.locator('#game-opera')
    await game.locator('.mv').first().waitFor()

    // Nothing inline any more...
    assert.strictEqual(await game.locator('.cm').count(), 0)

    // ...and the box follows the position.
    const box = game.locator('.comment')
    await game.locator('.mv', { hasText: 'd6' }).first().click()
    assert.match(await box.textContent(), /Philidor's Defence/)
    assert.match(await box.locator('.who').textContent(), /^2… d6$/)

    await game.locator('#first').click()
    assert.strictEqual(await box.textContent(), '')
  })

  /* PGN spec 6: a `%` in the FIRST column means the rest of the line is
   * ignored. A bracket in such a line is not a bracket, so the open-bracket
   * hint must not claim one is waiting. */
  test('a bracket on a %-escaped line is not an open bracket', async () => {
    const notes = await page.evaluate(async () => {
      const out = []
      for (const src of ['% [ ignored\n1. e4 zz', '[Event "x" 1. e4 *']) {
        const el = document.createElement('chess-view')
        el.textContent = src
        document.body.append(el)
        await new Promise((r) => setTimeout(r, 50))
        out.push(el.shadowRoot.querySelector('.note.bad').textContent)
        el.remove()
      }
      return out
    })
    // The escaped bracket is invisible, so no "still open" clause...
    assert.strictEqual(notes[0], '“zz” is not chess notation — line 2, column 7.')
    // ...while a real unclosed tag still earns one.
    assert.match(notes[1], /The tag opened at line 1, column 1 is still open\.$/)
  })

  test('the switches each take a part of the UI away', async () => {
    const bare = page.locator('#game-diagram')
    await bare.locator('rect.sq').first().waitFor()

    assert.strictEqual(await bare.locator('.side').count(), 1, 'still in the DOM')
    assert.strictEqual(await bare.locator('.side').isVisible(), false, 'but not on screen')
    assert.strictEqual(await bare.locator('.bar').isVisible(), false)
    assert.strictEqual(await bare.locator('text.co').first().isVisible(), false)
    // The board itself is untouched, and opened at the ply it was given.
    assert.strictEqual(await bare.locator('rect.sq').count(), 64)
    assert.strictEqual(await bare.locator('rect.hl.check').count(), 1, 'mate is on the board')
  })

  /* The source pane. */

  test('source="edit" shows the notation and re-parses what you type', async () => {
    const game = page.locator('#game-editor')
    const editor = game.locator('textarea')
    await editor.waitFor()

    assert.match(await editor.inputValue(), /^1\. d4 d5 2\. c4/)
    assert.strictEqual(await game.locator('.ply').textContent(), '0 / 6')

    await editor.focus()
    await editor.press('End')
    await editor.press('ArrowLeft') // before the `*`
    await editor.pressSequentially('4. cxd5 exd5 ')

    // Playwright's locators pierce the shadow root; a raw querySelector in
    // the page does not, so this has to go through shadowRoot itself.
    await page.waitForFunction(
      () =>
        '0 / 8' ===
        document.getElementById('game-editor')?.shadowRoot?.querySelector('.ply')
          ?.textContent,
      null,
      { timeout: 5000 },
    )
    assert.match(await game.locator('.moves').textContent(), /cxd5/)
  })

  test('typing keeps the board rather than blanking it on every keystroke', async () => {
    const game = page.locator('#game-editor')
    const editor = game.locator('textarea')

    const before = await game.locator('text.pc').count()
    await editor.focus()
    await editor.press('End')
    await editor.pressSequentially(' 5. Nf')  // a half-typed move: not a game yet

    await game.locator('.note.bad').waitFor()
    assert.strictEqual(await game.locator('text.pc').count(), before, 'board survived')
    assert.strictEqual(await game.locator('rect.sq').count(), 64)
  })

  test('editing fires chess-source, and f types an f rather than flipping', async () => {
    const game = page.locator('#game-editor')
    const editor = game.locator('textarea')

    const corner = () => game.locator('text.co.file').first().textContent()
    const was = await corner()

    const seen = page.evaluate(
      () =>
        new Promise((resolve) => {
          document.addEventListener(
            'chess-source',
            (e) => resolve({ ok: e.detail.ok, tail: e.detail.source.slice(-2) }),
            { once: true },
          )
        }),
    )
    await editor.focus()
    await editor.press('End')
    await editor.pressSequentially('f')

    const detail = await seen
    assert.strictEqual(detail.tail.endsWith('f'), true, 'the f reached the source')
    assert.strictEqual(await corner(), was, 'the board did not flip')
  })
})

/* The other way a page loads this: as a module, from a URL.
 *
 * Over http rather than file://, because that is what a CDN is, and
 * because a browser refuses a module script from a file:// origin. The
 * suite above proves the IIFE build registers the element; this proves
 * the ESM build does, which is the half a bundler and a
 * <script type="module"> both take.
 */
describe('<chess-view> as an ES module over http', { skip }, () => {
  const DIST = path.join(__dirname, '..', 'dist')
  // The empty data: icon is not decoration. Without it the browser asks
  // for /favicon.ico of its own accord, which is a 404 in the console and
  // a third request in a test that counts them.
  const PAGE = `<!doctype html><meta charset="utf-8">
<link rel="icon" href="data:,">
<script type="module" src="./chess-view.mjs"></script>
<chess-view>1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1/2-1/2</chess-view>`

  const TYPES = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.html': 'text/html' }

  let browser
  let page
  let server
  let origin
  const errors = []

  before(async () => {
    server = require('node:http').createServer((req, res) => {
      const url = req.url.split('?')[0]
      if ('/' === url) {
        res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE)
        return
      }
      const file = path.join(DIST, path.normalize(url).replace(/^(\.\.[/\\])+/, ''))
      if (!file.startsWith(DIST) || !fs.existsSync(file)) {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' })
      res.end(fs.readFileSync(file))
    })
    await new Promise((done) => server.listen(0, '127.0.0.1', done))
    origin = `http://127.0.0.1:${server.address().port}`

    browser = await chromium.launch({ executablePath })
    page = await browser.newPage()
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => {
      if ('error' === m.type()) errors.push(m.text())
    })
    await page.goto(origin + '/')
    await page.waitForFunction(() => !!customElements.get('chess-view'))
  })

  after(async () => {
    await browser?.close()
    await new Promise((done) => server.close(done))
  })

  test('the module registers the element and draws a board', async () => {

    assert.deepStrictEqual(errors, [])
    assert.strictEqual(await page.locator('chess-view rect.sq').count(), 64)
    assert.strictEqual(await page.locator('chess-view text.pc').count(), 32)
  })

  test('it is still self-contained: the page and the module, nothing else', async () => {

    const fetched = []
    page.on('request', (r) => fetched.push(r.url().replace(origin, '')))
    await page.reload()
    await page.waitForFunction(() => !!customElements.get('chess-view'))
    assert.deepStrictEqual(fetched, ['/', '/chess-view.mjs'])
  })
})
