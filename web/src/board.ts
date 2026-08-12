/* Copyright (c) 2026 Richard Rodger, MIT License */

/* The board view: a position rendered as one inline SVG.
 *
 * SVG rather than a grid of DOM nodes because it scales to any size from
 * one `viewBox` and needs no assets — the component has to be a single
 * file, so a piece sprite sheet is out.
 *
 * Pieces are the SOLID Unicode glyphs (U+265A..U+265F) for both colours,
 * painted light or dark and outlined with `paint-order: stroke`. The
 * hollow white glyphs (U+2654..) are the obvious choice and the wrong one:
 * their weight varies wildly between the fonts that carry them, so a board
 * drawn with both sets looks lopsided. One shape, two paints, is even.
 */

import type { PieceCode, Position } from './position'

const GLYPH: Record<string, string> = {
  k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟',
}

const FILES = 'abcdefgh'

export interface BoardView {
  position: Position
  /** Origin and destination of the move just played, as 0x88 indices. */
  from?: number
  to?: number
  /** `true` to view from Black's side. */
  flipped?: boolean
  /** Square of a king in check, to mark. */
  check?: number
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Render `view` as an SVG string with a 0 0 100 100 viewBox. */
export function boardSvg(view: BoardView): string {
  const { position, flipped } = view
  const parts: string[] = []
  const size = 12
  const pad = 2

  // Squares, then coordinates, then pieces: pieces must paint last so a
  // glyph's outline is never clipped by the next square.
  const pieces: string[] = []

  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const index = flipped ? ((7 - rank) << 4) + (7 - file) : (rank << 4) + file
      const x = pad + file * size
      const y = pad + rank * size
      const dark = 1 === ((rank + file) & 1)

      // The square, then any highlight OVER it. A translucent highlight
      // used as the square's own fill composites against the page instead
      // of against the board, which washes light squares out.
      parts.push(
        `<rect class="sq ${dark ? 'dark' : 'light'}" x="${x}" y="${y}" ` +
          `width="${size}" height="${size}"/>`,
      )

      const mark =
        index === view.check ? 'check'
        : index === view.to ? 'to'
        : index === view.from ? 'from'
        : ''
      if (mark) {
        parts.push(
          `<rect class="hl ${mark}" x="${x}" y="${y}" ` +
            `width="${size}" height="${size}"/>`,
        )
      }

      const piece = position.board[index] as PieceCode | null
      if (null != piece) {
        const colour = 'w' === piece[0] ? 'white' : 'black'
        pieces.push(
          `<text class="pc ${colour}" x="${x + size / 2}" y="${y + size / 2}">` +
            GLYPH[piece[1]] +
            '</text>',
        )
      }
    }
  }

  // Coordinates in the board's own margin, so the squares stay square.
  for (let i = 0; i < 8; i++) {
    const file = flipped ? FILES[7 - i] : FILES[i]
    const rank = flipped ? i + 1 : 8 - i
    parts.push(
      `<text class="co file" x="${pad + i * size + size / 2}" y="${pad + 8 * size + 1.4}">${file}</text>`,
      `<text class="co rank" x="${pad - 0.7}" y="${pad + i * size + size / 2}">${rank}</text>`,
    )
  }

  return (
    `<svg class="board" viewBox="0 0 ${pad * 2 + 8 * size} ${pad * 2 + 8 * size + 1}" ` +
    'role="img" aria-label="chess position">' +
    parts.join('') +
    pieces.join('') +
    '</svg>'
  )
}

/** A plain-text board, for the `aria-label` and for copy-paste. */
export function boardText(position: Position): string {
  const rows: string[] = []
  for (let rank = 0; rank < 8; rank++) {
    const row: string[] = []
    for (let file = 0; file < 8; file++) {
      const piece = position.board[(rank << 4) + file]
      row.push(null == piece ? '.' : 'w' === piece[0] ? piece[1].toUpperCase() : piece[1])
    }
    rows.push(esc(row.join(' ')))
  }
  return rows.join('\n')
}
