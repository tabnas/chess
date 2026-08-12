/* Copyright (c) 2026 Richard Rodger, MIT License */

/* Bundle entry point: register <chess-game> and re-export the pieces, so
 * the same file works as a drop-in <script> and as an ES module import.
 */

import { ChessGameElement, define } from './element'
import type { ChessMoveDetail } from './element'

export { ChessGameElement, define }
export type { ChessMoveDetail }
export { boardSvg, boardText } from './board'
export {
  applyMove,
  attacked,
  index,
  legalMoves,
  parseFen,
  resolve,
  square,
  startPosition,
} from './position'
export type { Colour, PieceType, PlayedMove, Position } from './position'

// The parsed move model, re-exported so a consumer can annotate what the
// component hands them without also depending on the parser package: the
// bundle vendors it, and so do the generated declarations.
export type { Command, Comment, Game, Line, Move } from '@tabnas/chess'

declare global {
  interface HTMLElementTagNameMap {
    'chess-game': ChessGameElement
  }

  // The event bubbles, so a listener on `document` or `window` is as
  // ordinary as one on the element — and is where most of them end up.
  // GlobalEventHandlersEventMap is the interface all three event maps
  // extend, so declaring it once covers all three.
  interface GlobalEventHandlersEventMap {
    'chess-move': CustomEvent<ChessMoveDetail>
  }
}

// Guard the registration: this file is imported by tests and by
// server-side renderers, where there is no custom element registry.
if ('undefined' !== typeof customElements) define()
