/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

/* The component, in a real browser, loaded the way a page loads it.
 *
 * This is the test the engine tests cannot be: it runs `dist/chess-game.js`
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

describe('<chess-game> in a browser', { skip }, () => {
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
    await page.waitForFunction(() => !!customElements.get('chess-game'))
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
    assert.deepStrictEqual(fetched, ['index.html', 'chess-game.js'])
  })

  test('every example on the page upgraded and drew a board', async () => {
    const count = await page.locator('chess-game').count()
    assert.ok(4 <= count, `expected several examples, got ${count}`)
    for (let i = 0; i < count; i++) {
      const squares = await page.locator('chess-game').nth(i).locator('rect.sq').count()
      assert.strictEqual(squares, 64, `example ${i} should have 64 squares`)
    }
  })

  test('the starting position has 32 pieces on it', async () => {
    const game = page.locator('chess-game').first()
    assert.strictEqual(await game.locator('text.pc').count(), 32)
  })

  test('stepping forward plays the move and marks it', async () => {
    const game = page.locator('chess-game').first()
    await game.locator('#first').click()
    await game.locator('#next').click()

    assert.strictEqual(await game.locator('.mv.on').textContent(), 'e4')
    assert.match(await game.locator('.ply').textContent(), /^1 \/ /)
    // e2 vacated, e4 occupied: two marked squares, one for each.
    assert.strictEqual(await game.locator('rect.hl').count(), 2)
  })

  test('stepping back returns to the starting position', async () => {
    const game = page.locator('chess-game').first()
    await game.locator('#prev').click()
    assert.strictEqual(await game.locator('.mv.on').count(), 0)
    assert.strictEqual(await game.locator('.ply').textContent(), '0 / 85')
  })

  test('the arrow keys step too', async () => {
    const game = page.locator('chess-game').first()
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
    const game = page.locator('chess-game').first()
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
    const game = page.locator('chess-game').first()
    await game.locator('#last').click()
    assert.strictEqual(await game.locator('.ply').textContent(), '85 / 85')
    // The Fischer-Spassky ending, agreed drawn after 43. Re6: rook, king
    // and three pawns against bishop, knight, king and three pawns.
    assert.strictEqual(await game.locator('text.pc').count(), 11)
  })

  test('flipping swaps which corner a1 is in', async () => {
    const game = page.locator('chess-game').first()
    const first = () => game.locator('text.co.file').first().textContent()
    assert.strictEqual(await first(), 'a')
    await game.locator('#flip').click()
    assert.strictEqual(await first(), 'h')
    await game.locator('#flip').click()
    assert.strictEqual(await first(), 'a')
  })

  test('orientation="black" starts flipped', async () => {
    const game = page.locator('chess-game').nth(1)
    assert.strictEqual(await game.locator('text.co.file').first().textContent(), 'h')
  })

  test('a variation is navigable, and ⏮ leaves it', async () => {
    const game = page.locator('chess-game').nth(1)
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
    const game = page.locator('chess-game').last()
    assert.strictEqual(await game.locator('.mv.bad').textContent(), 'Qxh8')
    assert.match(await game.locator('.note.bad').textContent(), /not a legal move/)
  })

  test('changing the text content reloads the game', async () => {
    await page.evaluate(() => {
      const el = document.createElement('chess-game')
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

  test('source that is not chess notation reports the syntax error', async () => {
    await page.evaluate(() => {
      const el = document.createElement('chess-game')
      el.id = 'nonsense'
      el.textContent = '1. e4 zz'
      document.body.append(el)
    })
    const note = page.locator('#nonsense .note.bad')
    await note.waitFor()
    assert.match(await note.textContent(), /unexpected/)
  })
})
