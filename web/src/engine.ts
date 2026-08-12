/* Copyright (c) 2026 Richard Rodger, MIT License */

/* The board half of the component, with no DOM in it.
 *
 * @tabnas/chess parses notation; this replays it. The split is the same
 * one the parser draws — a parser has no board, so `Nf3` names a piece and
 * a destination and stops there — and keeping it as its own entry point
 * means the replay logic can be tested, and reused, without a browser.
 */

export * from './position'
export { boardText } from './board'
