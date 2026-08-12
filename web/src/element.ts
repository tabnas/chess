/* Copyright (c) 2026 Richard Rodger, MIT License */

/* <chess-game> — a chessboard view of a PGN game.
 *
 *   <chess-game>1. e4 e5 2. Nf3 {solid} Nc6 1/2-1/2</chess-game>
 *
 * The game is the element's text content, so the markup is the notation
 * and nothing else. Everything is inside a shadow root, and the built
 * bundle vendors @tabnas/chess and the engine, so the file is the whole
 * component.
 */

import { parse } from '@tabnas/chess'
import type { Game, Line, Move } from '@tabnas/chess'

import { boardSvg, boardText } from './board'
import { applyMove, attacked, parseFen, resolve, startPosition } from './position'
import type { Position } from './position'
import { STYLE } from './style'

/**
 * One navigable point in the game: the position AFTER `move`, plus enough
 * context to walk the line it belongs to.
 *
 * A variation is a line like any other, so the same shape covers both and
 * next/prev stay inside whichever line you are looking at.
 */
interface Node {
  id: number
  move: Move
  /** The position after `move`; the position before it, if unresolvable. */
  position: Position
  from?: number
  to?: number
  /** All nodes of this line, in order, including this one. */
  line: Node[]
  at: number
  depth: number
  /** Set when the notation was legal syntax but not a legal move here. */
  error?: string
}

interface Built {
  start: Position
  nodes: Node[]
  mainline: Node[]
  notation: string
  error?: string
}

/**
 * The `detail` of the `chess-move` event, fired on every navigation.
 *
 * Exported because it is the one shape a consumer has to know: the event
 * bubbles, so a listener anywhere on the page receives it.
 */
export interface ChessMoveDetail {
  /** The move now shown, or `undefined` at the starting position. */
  move?: Move
  /** How far into the current line the view is; `0` is the start. */
  ply: number
}

/* PGN spec 8.2.3.8 defines these six glyphs as exactly the traditional
 * suffix annotations, so showing the symbol is the standard's own
 * equivalence rather than an interpretation. Every other glyph stays `$n`:
 * section 10's list runs to 255 entries with no agreed symbols. */
const NAG_SYMBOL: Record<number, string> = {
  1: '!', 2: '?', 3: '!!', 4: '??', 5: '!?', 6: '?!',
}

const RESULT_WORD: Record<string, string> = {
  '1-0': 'White wins',
  '0-1': 'Black wins',
  '1/2-1/2': 'Draw',
  '*': 'Unfinished',
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Replay a game, resolving each parsed move against the running position.
 *
 * A move that does not resolve stops its line: the notation was
 * well-formed (the parser accepted it) but does not describe a move in
 * this position, and replaying past that would show a board that never
 * existed. That is a different failure from bad syntax, and is reported
 * as one.
 */
function build(game: Game): Built {
  let start: Position
  try {
    start = game.tags?.FEN ? parseFen(game.tags.FEN) : startPosition()
  } catch {
    start = startPosition()
  }

  const nodes: Node[] = []
  let error: string | undefined

  const walk = (line: Line, from: Position, depth: number): Node[] => {
    const built: Node[] = []
    let position = from

    for (const move of line.moves) {
      const before = position
      const node: Node = {
        id: nodes.length,
        move,
        position: before,
        line: built,
        at: built.length,
        depth,
      }

      const played = resolve(before, move)
      if (played) {
        position = applyMove(before, played)
        node.position = position
        node.from = played.from
        node.to = played.to
      } else {
        node.error = `${move.san}: not a legal move in this position`
        error = error ?? `Move ${move.number}${'w' === move.side ? '.' : '...'} ${node.error}`
      }

      nodes.push(node)
      built.push(node)

      // A variation REPLACES the move it follows (PGN spec 8.2.5), so it
      // branches from the position before that move, not after it.
      for (const variation of move.variations || []) {
        walk(variation, before, depth + 1)
      }

      if (node.error) break
    }

    return built
  }

  const mainline = walk(game, start, 0)
  return { start, nodes, mainline, notation: notationHtml(game, nodes), error }
}

/** Notation markup: every move is a button that jumps to its position. */
function notationHtml(game: Game, nodes: Node[]): string {
  const byMove = new Map<Move, Node>()
  for (const node of nodes) byMove.set(node.move, node)

  const out: string[] = []

  const annotate = (nags?: number[], comments?: { text: string }[]) => {
    for (const nag of nags || []) {
      const symbol = NAG_SYMBOL[nag]
      out.push(
        `<span class="nag" title="Numeric annotation glyph $${nag}">` +
          (symbol ? esc(symbol) : `$${nag}`) +
          '</span>',
      )
    }
    for (const comment of comments || []) {
      const text = comment.text.trim()
      if (text) out.push(`<span class="cm">${esc(text)}</span>`)
    }
  }

  const walk = (line: Line, depth: number) => {
    annotate(line.nags, line.comments)
    let numbered = -1

    for (const move of line.moves) {
      const node = byMove.get(move)
      const white = 'w' === move.side

      // 8.2.2.2: a number before every White move, and before a Black one
      // only where the run of moves was broken.
      if (white || numbered !== move.number) {
        out.push(`<span class="no">${move.number}${white ? '.' : '...'}</span>`)
      }
      numbered = move.number as number

      out.push(
        `<button class="mv${node?.error ? ' bad' : ''}" type="button" ` +
          `data-node="${node ? node.id : -1}"` +
          (node?.error ? ` title="${esc(node.error)}"` : '') +
          `>${esc(move.san)}${esc(move.annotation || '')}</button>`,
      )

      annotate(move.nags, move.comments)

      for (const variation of move.variations || []) {
        out.push('<span class="var">(')
        walk(variation, depth + 1)
        out.push(')</span>')
        // After a variation, the mainline needs its number again.
        numbered = -1
      }
    }
  }

  walk(game, 0)

  if (game.result) {
    out.push(
      `<span class="res" title="${RESULT_WORD[game.result] || ''}">${game.result}</span>`,
    )
  }

  return out.join(' ')
}

const TEMPLATE = `
<div class="wrap" part="wrap">
  <div class="boardpane">
    <div class="boardbox" id="board" part="board"></div>
    <div class="bar" part="controls">
      <button type="button" id="first" title="Start (Home)" aria-label="Start">&#9198;</button>
      <button type="button" id="prev" title="Previous (Left arrow)" aria-label="Previous">&#9664;</button>
      <button type="button" id="next" title="Next (Right arrow)" aria-label="Next">&#9654;</button>
      <button type="button" id="last" title="End (End)" aria-label="End">&#9197;</button>
      <button type="button" id="flip" title="Flip the board (f)" aria-label="Flip the board">&#8645;</button>
      <span class="ply" id="ply" aria-live="polite"></span>
    </div>
  </div>
  <div class="side" part="notation">
    <div class="tags" id="tags"></div>
    <div class="moves" id="moves" part="moves" tabindex="0"></div>
    <div class="note" id="note" role="status"></div>
  </div>
</div>`

/* `class X extends HTMLElement` evaluates HTMLElement where the class is
 * defined, not where it is instantiated — so on a server, merely importing
 * this module would throw, and server-rendering frameworks import
 * component packages on the server as a matter of course. A stand-in base
 * makes the import harmless there. Registration is separately guarded, so
 * nothing goes on to ask for a custom element registry that is not there. */
const Base: typeof HTMLElement =
  'undefined' === typeof HTMLElement
    ? (class {} as unknown as typeof HTMLElement)
    : HTMLElement

export class ChessGameElement extends Base {
  static observedAttributes = ['orientation', 'game', 'ply']

  #root: ShadowRoot
  #built?: Built
  #node?: Node
  #flipped = false
  #observer?: MutationObserver
  #wired = false

  constructor() {
    super()
    this.#root = this.attachShadow({ mode: 'open' })
    this.#root.innerHTML = `<style>${STYLE}</style>${TEMPLATE}`
  }

  connectedCallback() {
    if (!this.#wired) {
      this.#wired = true
      this.#wire()
    }
    // The notation is the element's content, so it has to be watched:
    // frameworks and template engines fill it in after upgrade.
    this.#observer = new MutationObserver(() => this.load())
    this.#observer.observe(this, { childList: true, characterData: true, subtree: true })
    this.load()
  }

  disconnectedCallback() {
    this.#observer?.disconnect()
    this.#observer = undefined
  }

  attributeChangedCallback(name: string) {
    if (!this.#wired) return
    if ('orientation' === name) {
      this.#flipped = 'black' === this.getAttribute('orientation')
      this.#draw()
    } else {
      this.load()
    }
  }

  /** The move currently shown, or `undefined` at the starting position. */
  get move(): Move | undefined {
    return this.#node?.move
  }

  /** How many moves into the current line the view is; 0 is the start. */
  get ply(): number {
    return this.#node ? this.#node.at + 1 : 0
  }

  /** Show the `n`th move of the current line. 0 is the starting position. */
  goto(n: number) {
    const line = this.#node?.line || this.#built?.mainline || []
    this.#go(0 < n ? line[n - 1] : undefined)
  }

  /** Re-read the text content and rebuild. Called automatically. */
  load() {
    const el = (id: string) => this.#root.getElementById(id) as HTMLElement
    const note = el('note')
    const moves = el('moves')
    const tags = el('tags')

    this.#flipped = 'black' === this.getAttribute('orientation')
    this.#node = undefined

    const fail = (message: string, bad: boolean) => {
      this.#built = undefined
      tags.textContent = ''
      moves.textContent = ''
      note.className = bad ? 'note bad' : 'note'
      note.textContent = message
      this.#draw()
    }

    let games: Game[]
    try {
      games = parse(this.textContent || '')
    } catch (err) {
      // A syntax error: the source is not chess notation. The engine's
      // message already names the row, column and offending characters.
      return fail(String((err as Error).message).split('\n')[0], true)
    }

    const which = Number(this.getAttribute('game') || 0)
    const game = games[which] || games[0]
    if (null == game) return fail('No game.', false)

    this.#built = build(game)

    tags.innerHTML = tagsHtml(game, games.length, which)
    moves.innerHTML = this.#built.notation
    for (const button of Array.from(moves.querySelectorAll('button[data-node]'))) {
      button.addEventListener('click', () => {
        this.#go(this.#built?.nodes[Number((button as HTMLElement).dataset.node)])
      })
    }

    note.className = this.#built.error ? 'note bad' : 'note'
    note.textContent = this.#built.error || ''

    const ply = this.getAttribute('ply')
    if (null != ply) this.goto(Number(ply))
    else this.#draw()
  }

  #wire() {
    const on = (id: string, fn: () => void) =>
      this.#root.getElementById(id)?.addEventListener('click', fn)

    const last = () => {
      const line = this.#node?.line || this.#built?.mainline
      this.#go(line?.[line.length - 1])
    }
    const flip = () => {
      this.#flipped = !this.#flipped
      this.#draw()
    }

    on('first', () => this.#go(undefined))
    on('prev', () => this.#step(-1))
    on('next', () => this.#step(1))
    on('last', last)
    on('flip', flip)

    if (!this.hasAttribute('tabindex')) this.tabIndex = 0
    this.addEventListener('keydown', (e: KeyboardEvent) => {
      const keys: Record<string, () => void> = {
        ArrowLeft: () => this.#step(-1),
        ArrowRight: () => this.#step(1),
        Home: () => this.#go(undefined),
        End: last,
        f: flip,
      }
      const fn = keys[e.key]
      if (fn) {
        e.preventDefault()
        fn()
      }
    })
  }

  #step(delta: number) {
    const line = this.#node?.line || this.#built?.mainline
    if (null == line) return
    const at = this.#node ? this.#node.at + delta : 0 < delta ? 0 : -1
    if (at >= line.length) return
    this.#go(0 > at ? undefined : line[at])
  }

  #go(node: Node | undefined) {
    this.#node = node
    this.#draw()
    const detail: ChessMoveDetail = { move: node?.move, ply: this.ply }
    this.dispatchEvent(new CustomEvent<ChessMoveDetail>('chess-move', { detail, bubbles: true }))
  }

  #draw() {
    const board = this.#root.getElementById('board') as HTMLElement
    const ply = this.#root.getElementById('ply') as HTMLElement
    const position = this.#node?.position || this.#built?.start || startPosition()

    // Mark the king only when it is actually in check — a stalemated king
    // has no moves either, and marking it would say the wrong thing.
    const king = position.board.indexOf((position.turn + 'k') as any)
    const check =
      0 <= king && attacked(position, king, 'w' === position.turn ? 'b' : 'w')
        ? king
        : undefined

    board.innerHTML = boardSvg({
      position,
      from: this.#node?.from,
      to: this.#node?.to,
      flipped: this.#flipped,
      check,
    })
    board.firstElementChild?.setAttribute(
      'aria-label',
      'Chess position.\n' + boardText(position),
    )

    const line = this.#node?.line || this.#built?.mainline || []
    ply.textContent = `${this.ply} / ${line.length}`

    for (const el of Array.from(this.#root.querySelectorAll('.mv.on'))) {
      el.classList.remove('on')
    }
    if (this.#node) {
      const el = this.#root.querySelector(
        `.mv[data-node="${this.#node.id}"]`,
      ) as HTMLElement | null
      if (el) {
        el.classList.add('on')
        scrollIntoView(this.#root.getElementById('moves') as HTMLElement, el)
      }
    }
  }
}

/**
 * Scroll `box` just far enough to show `el`, without touching any
 * ancestor. `Element.scrollIntoView` would scroll the page too, which is
 * hostile in a component embedded halfway down an article.
 */
function scrollIntoView(box: HTMLElement, el: HTMLElement) {
  const top = el.offsetTop - box.offsetTop
  const bottom = top + el.offsetHeight
  if (top < box.scrollTop) box.scrollTop = top
  else if (bottom > box.scrollTop + box.clientHeight) {
    box.scrollTop = bottom - box.clientHeight
  }
}

function tagsHtml(game: Game, total: number, which: number): string {
  const t = game.tags || {}
  const out: string[] = []
  const players = [t.White, t.Black].filter(Boolean).join(' — ')
  const meta = [t.Event, t.Site, t.Date].filter(Boolean).join(' · ')
  if (players) out.push(`<div class="players">${esc(players)}</div>`)
  if (meta) out.push(`<div class="meta">${esc(meta)}</div>`)
  if (1 < total) out.push(`<div class="meta">Game ${which + 1} of ${total}</div>`)
  return out.join('')
}

/** Register the element. Called automatically by the bundled build. */
export function define(name = 'chess-game') {
  if (!customElements.get(name)) customElements.define(name, ChessGameElement)
}
