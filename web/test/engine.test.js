/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

/* The move generator is the risky half of this component: @tabnas/chess
 * gives us `Nf3` and a board view has to decide WHICH knight, which needs
 * legal move generation. A generator that is subtly wrong shows a board
 * that never existed, so it is tested the way chess engines are tested —
 * with perft.
 *
 * perft(n) counts leaf nodes n plies deep. The numbers below are the
 * published ones for six standard positions; they are unforgiving,
 * because a single missing en-passant capture or an over-permissive
 * castle changes the count. Positions 2-6 exist precisely to catch the
 * cases the initial position cannot reach.
 *
 * Run against `dist/engine.cjs`, so what is tested is what is shipped.
 */

const { describe, test } = require('node:test')
const assert = require('node:assert')

const {
  applyMove,
  attacked,
  index,
  legalMoves,
  parseFen,
  resolve,
  square,
  startPosition,
} = require('../dist/engine.cjs')

const { parse } = require('@tabnas/chess')

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

function perft(position, depth) {
  if (0 === depth) return 1
  const moves = legalMoves(position)
  if (1 === depth) return moves.length
  let total = 0
  for (const move of moves) total += perft(applyMove(position, move), depth - 1)
  return total
}

describe('perft', () => {
  // https://www.chessprogramming.org/Perft_Results
  const suite = [
    ['initial position', START, [20, 400, 8902]],
    [
      'kiwipete — castling, pins and en passant together',
      'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
      [48, 2039],
    ],
    ['endgame — promotion and discovered check', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812]],
    [
      'promotion into check',
      'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1',
      [6, 264],
    ],
    ['no castling rights', 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486]],
    [
      'a dense middlegame',
      'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10',
      [46, 2079],
    ],
  ]

  for (const [name, fen, counts] of suite) {
    for (let depth = 1; depth <= counts.length; depth++) {
      test(`${name}: perft(${depth}) === ${counts[depth - 1]}`, () => {
        assert.strictEqual(perft(parseFen(fen), depth), counts[depth - 1])
      })
    }
  }

  // Depth 4 from the start is 197,281 leaves — slow, but it is the one
  // check that exercises every piece over a full pair of moves.
  test('initial position: perft(4) === 197281', { timeout: 120000 }, () => {
    assert.strictEqual(perft(startPosition(), 4), 197281)
  })
})

describe('squares', () => {
  test('index and square are inverse', () => {
    for (const name of ['a1', 'h1', 'a8', 'h8', 'e4', 'd5']) {
      assert.strictEqual(square(index(name)), name)
    }
  })

  test('the corners are where they should be', () => {
    const pos = startPosition()
    assert.strictEqual(pos.board[index('a1')], 'wr')
    assert.strictEqual(pos.board[index('e1')], 'wk')
    assert.strictEqual(pos.board[index('e8')], 'bk')
    assert.strictEqual(pos.board[index('d8')], 'bq')
    assert.strictEqual(pos.board[index('e4')], null)
  })
})

// Replay a game the way the component does, and report the first move
// that will not resolve.
function replay(pgn) {
  const game = parse(pgn)[0]
  let position = game.tags?.FEN ? parseFen(game.tags.FEN) : startPosition()
  const played = []
  for (const move of game.moves) {
    const resolved = resolve(position, move)
    if (!resolved) return { played, failed: move, position }
    position = applyMove(position, resolved)
    played.push({ move, resolved })
  }
  return { played, position }
}

describe('resolving notation against a position', () => {
  test('a full master game replays to the end', () => {
    const { played, failed } = replay(`
[Event "F/S Return Match"]
1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3
O-O 9. h3 Nb8 10. d4 Nbd7 11. c4 c6 12. cxb5 axb5 13. Nc3 Bb7 14. Bg5 b4 15.
Nb1 h6 16. Bh4 c5 17. dxe5 Nxe4 18. Bxe7 Qxe7 19. exd6 Qf6 20. Nbd2 Nxd6 21.
Nc4 Nxc4 22. Bxc4 Nb6 23. Ne5 Rae8 24. Bxf7+ Rxf7 25. Nxf7 Rxe1+ 26. Qxe1 Kxf7
27. Qe3 Qg5 28. Qxg5 hxg5 29. b3 Ke6 30. a3 Kd6 31. axb4 cxb4 32. Ra5 Nd5 33.
f3 Bc8 34. Kf2 Bf5 35. Ra7 g6 36. Ra6+ Kc5 37. Ke1 Nf4 38. g3 Nxh3 39. Kd2 Kb5
40. Rd6 Kc5 41. Ra6 Nf2 42. g4 Bd3 43. Re6 1/2-1/2`)

    assert.strictEqual(failed, undefined, failed && failed.san)
    assert.strictEqual(played.length, 85)
  })

  test('a game ending in mate replays, castling and all', () => {
    const { played, failed, position } = replay(`
1. e4 e5 2. f4 exf4 3. Bc4 Qh4+ 4. Kf1 b5 5. Bxb5 Nf6 6. Nf3 Qh6 7. d3 Nh5
8. Nh4 Qg5 9. Nf5 c6 10. g4 Nf6 11. Rg1 cxb5 12. h4 Qg6 13. h5 Qg5 14. Qf3 Ng8
15. Bxf4 Qf6 16. Nc3 Bc5 17. Nd5 Qxb2 18. Bd6 Bxg1 19. e5 Qxa1+ 20. Ke2 Na6
21. Nxg7+ Kd8 22. Qf6+ Nxf6 23. Be7# 1-0`)

    assert.strictEqual(failed, undefined, failed && failed.san)
    assert.strictEqual(played.length, 45)
    // Mate: Black to move, in check, and with nothing to play.
    const king = position.board.indexOf('bk')
    assert.ok(attacked(position, king, 'w'), 'black king should be in check')
    assert.strictEqual(legalMoves(position).length, 0)
  })

  // A cleared back rank, so the only question is where the king and rook
  // land — and that castling is spent afterwards.
  const CASTLE_FEN = '[FEN "r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1"]'

  test('queenside castling puts the king on c and the rook on d', () => {
    const { failed, position } = replay(`${CASTLE_FEN}\n1. O-O-O O-O-O`)
    assert.strictEqual(failed, undefined, failed && failed.san)
    assert.strictEqual(position.board[index('c1')], 'wk')
    assert.strictEqual(position.board[index('d1')], 'wr')
    assert.strictEqual(position.board[index('c8')], 'bk')
    assert.strictEqual(position.board[index('d8')], 'br')
    assert.strictEqual(position.castling, '', 'both sides have spent it')
  })

  test('kingside castling puts the king on g and the rook on f', () => {
    const { failed, position } = replay(`${CASTLE_FEN}\n1. O-O O-O`)
    assert.strictEqual(failed, undefined, failed && failed.san)
    assert.strictEqual(position.board[index('g1')], 'wk')
    assert.strictEqual(position.board[index('f1')], 'wr')
    assert.strictEqual(position.board[index('g8')], 'bk')
    assert.strictEqual(position.board[index('f8')], 'br')
  })

  test('a king that has castled cannot castle again', () => {
    const { failed } = replay(`${CASTLE_FEN}\n1. O-O h6 2. O-O-O`)
    assert.strictEqual(failed && failed.san, 'O-O-O')
  })

  test('castling in a real opening', () => {
    const { failed, position } = replay(
      '1. d4 d5 2. Nc3 Nf6 3. Bf4 Bf5 4. Qd2 e6 5. O-O-O Be7 6. e3 O-O',
    )
    assert.strictEqual(failed, undefined, failed && failed.san)
    assert.strictEqual(position.board[index('c1')], 'wk')
    assert.strictEqual(position.board[index('g8')], 'bk')
  })

  test('en passant removes the pawn beside, not the one ahead', () => {
    const { failed, position } = replay('1. e4 Nf6 2. e5 d5 3. exd6')
    assert.strictEqual(failed, undefined, failed && failed.san)
    assert.strictEqual(position.board[index('d6')], 'wp')
    assert.strictEqual(position.board[index('d5')], null, 'the captured pawn')
  })

  test('promotion puts the named piece on the board', () => {
    const { failed, position } = replay(
      '[FEN "8/P6k/8/8/8/8/7K/8 w - - 0 1"]\n1. a8=N Kg7 2. Nc7 Kf7',
    )
    assert.strictEqual(failed, undefined, failed && failed.san)
    assert.strictEqual(position.board[index('c7')], 'wn')
  })

  test('a pinned piece is not a candidate, so the notation stays unambiguous', () => {
    // PGN spec 8.2.3.4's own example: knights on c3 and g1 both reach e2,
    // but the c3 knight is pinned by the bishop on b4, so `Ne2` names the
    // g1 knight and needs no disambiguation.
    const position = parseFen('4k3/8/8/8/1b6/2N5/8/4K1N1 w - - 0 1')
    const move = resolve(position, { san: 'Ne2', piece: 'N', to: 'e2' })
    assert.ok(move, 'Ne2 should resolve')
    assert.strictEqual(square(move.from), 'g1')
  })

  test('an ambiguous move resolves to nothing rather than to a guess', () => {
    const position = parseFen('4k3/8/8/8/8/2N3N1/8/4K3 w - - 0 1')
    assert.strictEqual(resolve(position, { san: 'Ne2', piece: 'N', to: 'e2' }), undefined)
    // With the file stated it is a move again.
    const move = resolve(position, {
      san: 'Nce2', piece: 'N', to: 'e2', disambiguation: { file: 'c' },
    })
    assert.strictEqual(square(move.from), 'c3')
  })

  test('a legal-looking move that is not legal here resolves to nothing', () => {
    const { failed, played } = replay('1. e4 e5 2. Nf3 Nc6 3. Qxh8 1-0')
    assert.strictEqual(played.length, 4)
    assert.strictEqual(failed.san, 'Qxh8')
  })

  test('a king may not castle out of, through, or into check', () => {
    const through = parseFen('4k3/8/8/8/8/8/5q2/4K2R w K - 0 1')
    assert.ok(!legalMoves(through).some((m) => 'k' === m.castle))
    const outOf = parseFen('4k3/8/8/8/8/8/4q3/4K2R w K - 0 1')
    assert.ok(!legalMoves(outOf).some((m) => 'k' === m.castle))
    const clear = parseFen('4k3/8/8/8/8/8/8/4K2R w K - 0 1')
    assert.ok(legalMoves(clear).some((m) => 'k' === m.castle))
  })

  test('losing a rook loses the castling right on that side', () => {
    const { position } = replay(
      '[FEN "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1"]\n1. Rxa8 Rxa1',
    )
    assert.strictEqual(position.castling, 'Kk')
  })
})

describe('FEN', () => {
  test('the initial array round-trips into the expected pieces', () => {
    const pos = parseFen(START)
    assert.strictEqual(pos.turn, 'w')
    assert.strictEqual(pos.castling, 'KQkq')
    assert.strictEqual(pos.ep, -1)
    assert.strictEqual(pos.fullmove, 1)
  })

  test('side to move and fullmove number are read', () => {
    const pos = parseFen('8/8/8/8/8/8/8/8 b - - 3 42')
    assert.strictEqual(pos.turn, 'b')
    assert.strictEqual(pos.fullmove, 42)
    assert.strictEqual(pos.halfmove, 3)
  })

  test('an unreadable record throws rather than inventing a board', () => {
    assert.throws(() => parseFen('nonsense'))
    assert.throws(() => parseFen('xxxxxxxx/8/8/8/8/8/8/8 w - - 0 1'))
  })
})
