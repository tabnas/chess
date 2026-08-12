/* Copyright (c) 2026 Richard Rodger, MIT License */

/* A minimal chess position, and the move generator that resolves notation
 * against it.
 *
 * @tabnas/chess deliberately has no board: `Nf3` names a destination and a
 * piece, and a parser cannot know WHICH knight without the position. A
 * board view has to know, so this file supplies the missing half — the
 * smallest correct thing that turns a parsed Move into a played move.
 *
 * "Correct" here means fully legal, not pseudo-legal. PGN spec 8.2.3.4
 * makes the point with an example: two knights on c3 and g1 both attack
 * e2, so `Ne2` looks ambiguous — but if the c3 knight is pinned, only one
 * knight can legally move there and `Ne2` is the right notation. Resolving
 * that needs check detection, so this generates legal moves, not merely
 * plausible ones.
 *
 * The board is 0x88: an index whose high nibble is the rank and low nibble
 * the file, so `i & 0x88` is a one-instruction off-board test.
 */

export type Colour = 'w' | 'b'
export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k'

/** A piece on a square: `wp` is a white pawn, `bk` a black king. */
export type PieceCode = `${Colour}${PieceType}`

export interface Position {
  /** 0x88 board; an empty square is `null`. */
  board: (PieceCode | null)[]
  turn: Colour
  /** Castling rights still held, as the FEN letters `KQkq`. */
  castling: string
  /** En passant target square (0x88 index), or -1. */
  ep: number
  halfmove: number
  fullmove: number
}

/** A move resolved against a position — the origin the notation omitted. */
export interface PlayedMove {
  from: number
  to: number
  piece: PieceType
  colour: Colour
  capture?: PieceType
  promotion?: PieceType
  castle?: 'k' | 'q'
  /** The square the captured pawn actually stood on, for en passant. */
  epCapture?: number
}

const FILES = 'abcdefgh'

const STEPS: Record<string, number[]> = {
  n: [-33, -31, -18, -14, 14, 18, 31, 33],
  b: [-17, -15, 15, 17],
  r: [-16, -1, 1, 16],
  q: [-17, -16, -15, -1, 1, 15, 16, 17],
  k: [-17, -16, -15, -1, 1, 15, 16, 17],
}

const SLIDES: Record<string, boolean> = { b: true, r: true, q: true }

export function square(index: number): string {
  return FILES[index & 15] + String(8 - (index >> 4))
}

export function index(square: string): number {
  const file = FILES.indexOf(square[0])
  const rank = 8 - Number(square[1])
  return 0 > file || 0 > rank || 7 < rank ? -1 : (rank << 4) + file
}

function onBoard(i: number): boolean {
  return 0 === (i & 0x88)
}

export function startPosition(): Position {
  return parseFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')
}

/**
 * Read a FEN record. Returns `undefined` for anything it cannot read, so a
 * malformed `FEN` tag falls back to the initial array rather than throwing
 * — the same choice the parser makes about move numbering.
 */
export function parseFen(fen: string): Position {
  const field = fen.trim().split(/\s+/)
  const board: (PieceCode | null)[] = new Array(128).fill(null)

  let i = 0
  for (const ch of field[0] || '') {
    if ('/' === ch) {
      i = (i + 16) & ~15
    } else if (/[1-8]/.test(ch)) {
      i += Number(ch)
    } else {
      const lower = ch.toLowerCase()
      if (!'pnbrqk'.includes(lower)) throw new Error('bad FEN piece: ' + ch)
      if (!onBoard(i)) throw new Error('FEN board overflows')
      board[i] = ((ch === lower ? 'b' : 'w') + lower) as PieceCode
      i++
    }
  }

  return {
    board,
    turn: 'b' === field[1] ? 'b' : 'w',
    castling: field[2] && '-' !== field[2] ? field[2] : '',
    ep: field[3] && '-' !== field[3] ? index(field[3]) : -1,
    halfmove: Number(field[4]) || 0,
    fullmove: Number(field[5]) || 1,
  }
}

function clone(pos: Position): Position {
  return { ...pos, board: pos.board.slice() }
}

function kingSquare(pos: Position, colour: Colour): number {
  for (let i = 0; i < 128; i++) {
    if (onBoard(i) && pos.board[i] === colour + 'k') return i
  }
  return -1
}

/** Is `target` attacked by any `by`-coloured piece? */
export function attacked(pos: Position, target: number, by: Colour): boolean {
  for (let from = 0; from < 128; from++) {
    if (!onBoard(from)) continue
    const piece = pos.board[from]
    if (null == piece || piece[0] !== by) continue
    const type = piece[1] as PieceType

    if ('p' === type) {
      const dir = 'w' === by ? -16 : 16
      if (from + dir - 1 === target || from + dir + 1 === target) return true
      continue
    }

    for (const step of STEPS[type]) {
      let to = from + step
      while (onBoard(to)) {
        if (to === target) return true
        if (null != pos.board[to] || !SLIDES[type]) break
        to += step
      }
    }
  }
  return false
}

function pushPawn(moves: PlayedMove[], pos: Position, from: number, to: number, extra: Partial<PlayedMove>) {
  const rank = to >> 4
  const last = 'w' === pos.turn ? 0 : 7
  const base: PlayedMove = { from, to, piece: 'p', colour: pos.turn, ...extra }
  if (rank === last) {
    for (const promotion of ['q', 'r', 'b', 'n'] as PieceType[]) {
      moves.push({ ...base, promotion })
    }
  } else {
    moves.push(base)
  }
}

/** Every move `pos.turn` may legally play. */
export function legalMoves(pos: Position): PlayedMove[] {
  const pseudo: PlayedMove[] = []
  const us = pos.turn
  const them: Colour = 'w' === us ? 'b' : 'w'

  for (let from = 0; from < 128; from++) {
    if (!onBoard(from)) continue
    const piece = pos.board[from]
    if (null == piece || piece[0] !== us) continue
    const type = piece[1] as PieceType

    if ('p' === type) {
      const dir = 'w' === us ? -16 : 16
      const start = 'w' === us ? 6 : 1

      const one = from + dir
      if (onBoard(one) && null == pos.board[one]) {
        pushPawn(pseudo, pos, from, one, {})
        const two = from + dir + dir
        if ((from >> 4) === start && null == pos.board[two]) {
          pseudo.push({ from, to: two, piece: 'p', colour: us })
        }
      }

      for (const side of [-1, 1]) {
        const to = from + dir + side
        if (!onBoard(to)) continue
        const target = pos.board[to]
        if (null != target && target[0] === them) {
          pushPawn(pseudo, pos, from, to, { capture: target[1] as PieceType })
        } else if (to === pos.ep) {
          // En passant: the captured pawn is beside us, not on `to`.
          pseudo.push({
            from, to, piece: 'p', colour: us,
            capture: 'p', epCapture: to - dir,
          })
        }
      }
      continue
    }

    for (const step of STEPS[type]) {
      let to = from + step
      while (onBoard(to)) {
        const target = pos.board[to]
        if (null == target) {
          pseudo.push({ from, to, piece: type, colour: us })
        } else {
          if (target[0] === them) {
            pseudo.push({ from, to, piece: type, colour: us, capture: target[1] as PieceType })
          }
          break
        }
        if (!SLIDES[type]) break
        to += step
      }
    }
  }

  // Castling: the king's path may not start, cross or end in check.
  const home = 'w' === us ? 0x70 : 0x00
  const rights = 'w' === us ? 'KQ' : 'kq'
  if (pos.board[home + 4] === us + 'k' && !attacked(pos, home + 4, them)) {
    if (
      pos.castling.includes(rights[0]) &&
      pos.board[home + 7] === us + 'r' &&
      null == pos.board[home + 5] && null == pos.board[home + 6] &&
      !attacked(pos, home + 5, them) && !attacked(pos, home + 6, them)
    ) {
      pseudo.push({ from: home + 4, to: home + 6, piece: 'k', colour: us, castle: 'k' })
    }
    if (
      pos.castling.includes(rights[1]) &&
      pos.board[home] === us + 'r' &&
      null == pos.board[home + 1] && null == pos.board[home + 2] && null == pos.board[home + 3] &&
      !attacked(pos, home + 3, them) && !attacked(pos, home + 2, them)
    ) {
      pseudo.push({ from: home + 4, to: home + 2, piece: 'k', colour: us, castle: 'q' })
    }
  }

  // Legality: a move that leaves our own king attacked is not a move. This
  // is what makes disambiguation match the notation a writer produced.
  return pseudo.filter((move) => {
    const next = applyMove(pos, move)
    const king = kingSquare(next, us)
    return -1 === king || !attacked(next, king, them)
  })
}

/** Play `move`, returning the new position. `pos` is not modified. */
export function applyMove(pos: Position, move: PlayedMove): Position {
  const next = clone(pos)
  const piece = next.board[move.from] as PieceCode

  next.board[move.from] = null
  next.board[move.to] = move.promotion
    ? ((move.colour + move.promotion) as PieceCode)
    : piece

  if (null != move.epCapture) next.board[move.epCapture] = null

  if (move.castle) {
    const home = 'w' === move.colour ? 0x70 : 0x00
    if ('k' === move.castle) {
      next.board[home + 5] = next.board[home + 7]
      next.board[home + 7] = null
    } else {
      next.board[home + 3] = next.board[home]
      next.board[home] = null
    }
  }

  // A two-square pawn push is the only thing that creates an ep target.
  next.ep = 'p' === move.piece && 32 === Math.abs(move.to - move.from)
    ? (move.from + move.to) / 2
    : -1

  // Castling rights are lost by moving the king or a rook, and by having
  // a rook captured on its home square.
  let castling = next.castling
  const drop = (letters: string) => {
    for (const l of letters) castling = castling.replace(l, '')
  }
  if ('k' === move.piece) drop('w' === move.colour ? 'KQ' : 'kq')
  if (0x77 === move.from || 0x77 === move.to) drop('K')
  if (0x70 === move.from || 0x70 === move.to) drop('Q')
  if (0x07 === move.from || 0x07 === move.to) drop('k')
  if (0x00 === move.from || 0x00 === move.to) drop('q')
  next.castling = castling

  next.halfmove = 'p' === move.piece || null != move.capture ? 0 : next.halfmove + 1
  if ('b' === move.colour) next.fullmove++
  next.turn = 'w' === move.colour ? 'b' : 'w'

  return next
}

/** What the parser gives us about a move, before a board is involved. */
export interface SanMove {
  san: string
  piece: string
  to?: string
  disambiguation?: { file?: string; rank?: number }
  promotion?: string
  castle?: string
}

/**
 * Resolve a parsed move against a position.
 *
 * Everything the parser recorded is a filter: the piece letter, the
 * destination, the promotion piece, and whichever half of the origin
 * square the writer had to disambiguate with. Exactly one legal move
 * should survive — anything else means the notation does not describe a
 * move in this position, which is a different failure from bad syntax and
 * is reported as such.
 */
export function resolve(pos: Position, san: SanMove): PlayedMove | undefined {
  const wanted = san.piece.toLowerCase() as PieceType
  const to = san.to ? index(san.to) : -1

  const candidates = legalMoves(pos).filter((move) => {
    if (san.castle) return move.castle === ('queen' === san.castle ? 'q' : 'k')
    if (move.castle) return false
    if (move.piece !== wanted || move.to !== to) return false
    if (san.promotion) {
      if (move.promotion !== san.promotion.toLowerCase()) return false
    } else if (move.promotion) {
      return false
    }
    const from = san.disambiguation
    if (from) {
      if (from.file && FILES[move.from & 15] !== from.file) return false
      if (from.rank && 8 - (move.from >> 4) !== from.rank) return false
    }
    return true
  })

  return 1 === candidates.length ? candidates[0] : undefined
}
