/* Copyright (c) 2026 Richard Rodger, MIT License */

/* Bundle entry point: register <chess-game> and re-export the pieces, so
 * the same file works as a drop-in <script> and as an ES module import.
 */

import { ChessGameElement, define } from './element'

export { ChessGameElement, define }
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

// Guard the registration: this file is imported by tests and by
// server-side renderers, where there is no custom element registry.
if ('undefined' !== typeof customElements) define()
