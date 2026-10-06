/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// Performance regression guard.
//
// The convenience `parse()` builds an engine per call, which is the right
// trade for a one-off but the wrong one for a PGN database. This guards the
// usage the docs recommend for bulk work — build ONE instance and reuse it
// — and would fail if a future change made a reused parse rebuild the
// grammar anyway. Building the grammar dominates a parse of this size.
//
// The check is machine-INDEPENDENT: it compares reuse against a single
// parse and against the rebuild-per-parse anti-pattern on the SAME machine
// in the SAME run, so a slow CI box scales everything together. A runner
// that stalls part of the run is the remaining noise, so each timing keeps
// the fastest of several rounds. There is deliberately NO absolute
// wall-clock budget.

import { test, describe } from 'node:test'
import assert from 'node:assert'

import { Tabnas } from '@tabnas/parser'
import { Chess } from '../dist/chess'

// A representative annotated game: tag pairs, comments, a glyph, a
// variation and a termination marker.
const SRC =
  '[Event "x"]\n[Result "1-0"]\n\n' +
  '1. e4 e5 2. Nf3 {solid} Nc6 $1 (2... d6 3. d4 exd4) 3. Bb5 a6 4. Ba4 Nf6 1-0'
const N = 1000

describe('perf', () => {
  test('reusing one instance stays linear and beats rebuild-per-parse', () => {
    // Build the reusable instance once (the expensive step).
    const tn = new Tabnas().use(Chess)

    // Warm the reuse path so the comparison is steady-state, and
    // sanity-check the parse result en route.
    for (let i = 0; i < 100; i++) {
      const game = tn.parse(SRC)[0]
      assert.equal(game.result, '1-0')
      assert.equal(game.moves.length, 8)
      assert.equal(game.moves[3].variations[0].moves.length, 3)
    }

    // Time one isolated (already-warmed) parse on the reused instance.
    let t0 = process.hrtime.bigint()
    tn.parse(SRC)
    const single = Number(process.hrtime.bigint() - t0)

    // Time N parses reusing the ONE instance, and N parses that REBUILD a
    // fresh instance every call (the anti-pattern this guards against).
    // Each is timed over ROUNDS rounds and the fastest round kept: a
    // shared CI runner can stall any single round, and the minimum is the
    // measurement least disturbed by that.
    const ROUNDS = 3
    let reuse = Infinity
    let rebuild = Infinity
    for (let round = 0; round < ROUNDS; round++) {
      t0 = process.hrtime.bigint()
      for (let i = 0; i < N; i++) {
        tn.parse(SRC)
      }
      reuse = Math.min(reuse, Number(process.hrtime.bigint() - t0))

      t0 = process.hrtime.bigint()
      for (let i = 0; i < N; i++) {
        new Tabnas().use(Chess).parse(SRC)
      }
      rebuild = Math.min(rebuild, Number(process.hrtime.bigint() - t0))
    }

    const avgReuse = reuse / N

    // 1) Reuse must stay (near) linear: amortized per-parse time over N
    //    reused parses should be within a small factor of a single warmed
    //    parse. Allow 4x for scheduling / timer noise.
    if (single > 0) {
      assert.ok(
        avgReuse <= 4 * single,
        `reuse is not staying linear: ${N} reused parses took ${(reuse / 1e6).toFixed(2)}ms ` +
          `(avg ${(avgReuse / 1e3).toFixed(2)}us/parse) vs ${(single / 1e3).toFixed(2)}us for a ` +
          `single parse (ratio ${(avgReuse / single).toFixed(1)}x, limit 4x)`,
      )
    }

    // 2) Reuse must be much faster than rebuilding per parse. Building the
    //    grammar dominates, so if a future change made representative usage
    //    rebuild on every parse the ratio would fall to about 1x. A 2x floor
    //    still fails that by a wide margin; >4x, the floor this test once
    //    had, failed on shared runners that measured 3.4x and 4.0x.
    assert.ok(
      rebuild >= 2 * reuse,
      `rebuild-per-parse is not dominated by reuse as expected: ` +
        `rebuild=${(rebuild / 1e6).toFixed(2)}ms reuse=${(reuse / 1e6).toFixed(2)}ms ` +
        `(ratio ${(rebuild / reuse).toFixed(1)}x, expected >2x). Building the grammar ` +
        `should dominate — reuse a single instance.`,
    )

    console.log(
      `[perf] single=${(single / 1e3).toFixed(2)}us  ` +
        `reuse(N=${N})=${(reuse / 1e6).toFixed(2)}ms avg=${(avgReuse / 1e3).toFixed(2)}us  ` +
        `rebuild(N=${N})=${(rebuild / 1e6).toFixed(2)}ms  ` +
        `reuse/single=${(avgReuse / Math.max(single, 1)).toFixed(2)}x  ` +
        `rebuild/reuse=${(rebuild / reuse).toFixed(1)}x`,
    )
  })
})
