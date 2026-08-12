/* Copyright (c) 2026 Richard Rodger, MIT License */

/* <chess-view> — a chessboard view of a PGN game.
 *
 *   <chess-view>1. e4 e5 2. Nf3 {solid} Nc6 1/2-1/2</chess-view>
 *
 * The game is the element's text content, so the markup is the notation
 * and nothing else. Everything is inside a shadow root, and the built
 * bundle vendors @tabnas/chess and the engine, so the file is the whole
 * component.
 */

import { parse, stripCommands } from '@tabnas/chess'
// `Comment` is also a DOM global; the alias keeps which one is meant plain.
import type { Comment as PgnComment, Game, Line, Move } from '@tabnas/chess'

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
  game: Game
  start: Position
  nodes: Node[]
  mainline: Node[]
  error?: string
}

/** How commentary is presented. */
type Commentary = 'inline' | 'panel' | 'hidden'

/** What the source pane does, if anything. */
type Source = 'hidden' | 'view' | 'edit'

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

/**
 * The `detail` of the `chess-source` event, fired when the source pane is
 * edited. The element does not write edits back to its own text content —
 * that would fight whatever put them there — so a host that wants to keep
 * them listens for this.
 */
export interface ChessSourceDetail {
  /** The notation as it now stands in the editor. */
  source: string
  /** Whether it parsed. Half-typed notation is the normal state here. */
  ok: boolean
  /** Why it did not parse, when it did not. */
  error?: string
}

/* PGN spec 8.2.3.8 defines these six glyphs as exactly the traditional
 * suffix annotations, so showing the symbol is the standard's own
 * equivalence rather than an interpretation. Every other glyph stays `$n`:
 * section 10's list runs to 255 entries with no agreed symbols. */
const NAG_SYMBOL: Record<number, string> = {
  1: '!', 2: '?', 3: '!!', 4: '??', 5: '!?', 6: '?!',
}

/* The supplement asks presentation software to "strip out all commands
 * before display in order to improve legibility", and it is right: without
 * that, a lichess export reads `[%clk 0:03:00]` where the annotator's
 * prose should be. But four of them say something a reader actually wants,
 * so they are shown as their own small chip instead of as markup. The rest
 * are dropped from the display and left in the parsed data for whoever
 * wants them — `csl` and `cal` are drawing instructions, and showing them
 * as text would be worse than showing nothing. */
const COMMAND_LABEL: Record<string, string> = {
  clk: 'Clock',
  emt: 'Move time',
  egt: 'Game time',
  mct: 'Mechanical clock',
  eval: 'Evaluation',
}

function commandsHtml(comments?: PgnComment[]): string {
  const out: string[] = []
  for (const comment of comments || []) {
    for (const command of comment.commands || []) {
      const label = COMMAND_LABEL[command.name]
      if (label) {
        out.push(
          `<span class="cmd" title="${label}">${esc(command.args.join(' '))}</span>`,
        )
      }
    }
  }
  return out.join('')
}

/** Comment bodies with the command markup taken out, empties dropped. */
function proseOf(comments?: PgnComment[]): string[] {
  const out: string[] = []
  for (const comment of comments || []) {
    const text = stripCommands(comment.text)
    if (text) out.push(text)
  }
  return out
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

const OPENER: Record<string, string> = { '(': 'variation', '{': 'comment', '[': 'tag' }

/**
 * The first bracket that is opened and never closed, if there is one.
 *
 * Deliberately approximate. It skips the inside of a comment, a
 * rest-of-line remark and a tag value, because a bracket in prose is
 * prose — but it does not pretend to be the lexer. The result is only ever
 * used to make an error message more helpful, so being wrong costs a
 * vaguer sentence and nothing else.
 */
function unclosed(source: string): { char: string; row: number; col: number } | undefined {
  const stack: { char: string; row: number; col: number }[] = []
  const opens: Record<string, string> = { ')': '(', '}': '{', ']': '[' }
  let row = 1
  let col = 1
  let inComment = false
  let inRemark = false
  let inString = false

  for (let i = 0; i < source.length; i++) {
    const c = source[i]

    if ('\n' === c) {
      row++
      col = 1
      inRemark = false
      // A brace comment may span lines (PGN spec 5); a tag value may not
      // (8.1), so an unclosed quote ends with the line rather than eating
      // the rest of the game.
      inString = false
      continue
    }

    if (inRemark) {
      /* rest-of-line comment: nothing in here is structure */
    } else if ('%' === c && 1 === col) {
      // PGN spec 6: a `%` in the FIRST column means the rest of the line is
      // ignored, so a bracket in it is not a bracket. The lexer's escape
      // matcher tests exactly this, and so must anything reading along
      // behind it.
      inRemark = true
    } else if (inComment) {
      if ('}' === c) {
        inComment = false
        stack.pop()
      }
    } else if (inString) {
      if ('\\' === c) {
        i++
        col++
      } else if ('"' === c) {
        inString = false
      }
    } else if ('"' === c) {
      inString = true
    } else if (';' === c) {
      inRemark = true
    } else if (null != opens[c]) {
      if (0 < stack.length && stack[stack.length - 1].char === opens[c]) stack.pop()
    } else if ('(' === c || '[' === c || '{' === c) {
      stack.push({ char: c, row, col })
      if ('{' === c) inComment = true
    }

    col++
  }

  return stack[0]
}

function sentence(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * Turn a parse error into a sentence a reader can act on.
 *
 * The grammar already replaces the engine's wording with the vocabulary of
 * chess notation, so most of this is presentation: drop the
 * `[tabnas/code]:` prefix, which names a code nobody looking at a
 * chessboard needs, and say where.
 *
 * Two things the grammar cannot do from inside, because both need the
 * whole source. It reports the single character the lexer stopped on,
 * where a reader would point at the whole word; and when the notation
 * simply runs out, the offending text is empty and what is actually
 * useful is the bracket that was never closed.
 */
function explain(err: unknown, source: string): string {
  const e = err as { message?: string; code?: string; lineNumber?: number; columnNumber?: number }
  const clean = String(e.message ?? '').split('\n')[0].replace(/^\[[^\]]*\]:\s*/, '')
  const row = e.lineNumber
  const col = e.columnNumber

  if (null == row || null == col) return sentence(clean || 'this is not chess notation') + '.'

  const line = source.split('\n')[row - 1] ?? ''
  const at = `line ${row}, column ${col}`

  // Only `unexpected` is rephrased: the other codes are already about a
  // specific thing (a comment, a tag value) and say it better than a
  // position alone would.
  if ('unexpected' === e.code) {
    const open = unclosed(source)

    // Past the end of the line: the notation ran out mid-game. The only
    // useful thing to say is which bracket is still waiting.
    if (col > line.length) {
      return open
        ? `The notation ends before the ${OPENER[open.char]} opened at ` +
            `line ${open.row}, column ${open.col} is closed.`
        : `The notation ends in the middle of a game, at ${at}.`
    }

    // Stopped on something concrete — but if a bracket is also still open,
    // that is usually what actually went wrong, and the parser stopping
    // here is the consequence.
    const found = /^\S+/.exec(line.slice(col - 1))
    const also = open
      ? ` The ${OPENER[open.char]} opened at line ${open.row}, column ${open.col} is still open.`
      : ''
    if (found) return `“${found[0]}” is not chess notation — ${at}.${also}`
  }

  return `${sentence(clean)} — ${at}.`
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
  return { game, start, nodes, mainline, error }
}

/**
 * Notation markup: every move is a button that jumps to its position.
 *
 * `prose` is false when commentary has a panel of its own, so that the
 * same commentary is not on screen twice.
 */
function notationHtml(game: Game, nodes: Node[], prose: boolean): string {
  const byMove = new Map<Move, Node>()
  for (const node of nodes) byMove.set(node.move, node)

  const out: string[] = []

  const annotate = (nags?: number[], comments?: PgnComment[]) => {
    for (const nag of nags || []) {
      const symbol = NAG_SYMBOL[nag]
      out.push(
        `<span class="nag" title="Numeric annotation glyph $${nag}">` +
          (symbol ? esc(symbol) : `$${nag}`) +
          '</span>',
      )
    }
    out.push(commandsHtml(comments))
    if (prose) {
      for (const text of proseOf(comments)) out.push(`<span class="cm">${esc(text)}</span>`)
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
    <div class="comment" id="comment" part="commentary" role="note"></div>
  </div>
  <!-- Outside the side panel on purpose: this reports on the component,
       not on the notation, so notation="hidden" must not silence it. A
       board with no visible reason for being empty is worse than none.
       (No backticks in here: TEMPLATE is a template literal.) -->
  <div class="note" id="note" part="status" role="status"></div>
  <div class="srcpane" part="source">
    <textarea id="src" part="editor" spellcheck="false" autocapitalize="off"
      autocorrect="off" aria-label="Chess notation source"></textarea>
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

export class ChessViewElement extends Base {
  static observedAttributes = [
    'orientation', 'game', 'ply',
    'source', 'commentary', 'controls', 'notation', 'tags', 'coordinates',
  ]

  #root: ShadowRoot
  #built?: Built
  #node?: Node
  #flipped = false
  #observer?: MutationObserver
  #wired = false
  /** Edited notation, when the editor holds something the light DOM does not. */
  #source?: string
  /** True while a keystroke in the editor is being applied. */
  #editing = false

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
    this.#observer = new MutationObserver(() => {
      // New text content is a new game, and supersedes whatever the
      // editor is holding. The element never writes to its own light DOM,
      // so this only ever fires for a change from outside.
      this.#source = undefined
      this.load()
    })
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
    } else if ('game' === name || 'ply' === name) {
      this.load()
    } else {
      // The rest change how the same game is presented, not which game it
      // is. Re-render, but do not re-parse and lose the reader's place.
      this.#render()
      this.#draw()
    }
  }

  /**
   * The notation this view is showing: its own text content, unless the
   * editor has been used, in which case what the editor holds.
   *
   * Setting it overrides the text content until the text content next
   * changes. Assigning `undefined` gives the text content back.
   */
  get source(): string {
    return this.#source ?? this.textContent ?? ''
  }

  set source(text: string | undefined) {
    this.#source = text
    this.load()
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

  /** Re-read the source and rebuild. Called automatically. */
  load() {
    const el = (id: string) => this.#root.getElementById(id) as HTMLElement
    const note = el('note')
    const moves = el('moves')
    const tags = el('tags')
    const source = this.source

    this.#flipped = 'black' === this.getAttribute('orientation')
    this.#syncEditor(source)

    const emit = (ok: boolean, error?: string) => {
      if (!this.#editing) return
      const detail: ChessSourceDetail = { source, ok, error }
      this.dispatchEvent(
        new CustomEvent<ChessSourceDetail>('chess-source', { detail, bubbles: true }),
      )
    }

    const say = (message: string, bad: boolean) => {
      note.className = bad ? 'note bad' : 'note'
      note.textContent = message
    }

    const fail = (message: string, bad: boolean) => {
      // Mid-edit, notation that does not parse is the normal state between
      // one valid game and the next — blanking the board on every
      // keystroke would make the editor unusable. Keep the last good
      // position on screen and say what is wrong.
      if (!this.#editing) {
        this.#built = undefined
        this.#node = undefined
        tags.textContent = ''
        moves.textContent = ''
        this.#draw()
      }
      say(message, bad)
      emit(false, message)
    }

    let games: Game[]
    try {
      games = parse(source)
    } catch (err) {
      // A syntax error: the source is not chess notation.
      return fail(explain(err, source), true)
    }

    const which = Number(this.getAttribute('game') || 0)
    const game = games[which] || games[0]
    if (null == game) return fail('No game.', false)

    // Keep the reader's place across an edit: the position they were
    // looking at is almost always still there a keystroke later.
    const was = this.#editing ? this.ply : 0

    this.#node = undefined
    this.#built = build(game)

    tags.innerHTML = tagsHtml(game, games.length, which)
    this.#render()
    say(this.#built.error || '', null != this.#built.error)
    emit(true, this.#built.error)

    const ply = this.getAttribute('ply')
    if (this.#editing) this.goto(Math.min(was, this.#built.mainline.length))
    else if (null != ply) this.goto(Number(ply))
    else this.#draw()
  }

  /** Re-render the notation from the current build, without re-parsing. */
  #render() {
    const moves = this.#root.getElementById('moves') as HTMLElement
    if (null == this.#built) {
      moves.textContent = ''
      return
    }

    moves.innerHTML = notationHtml(
      this.#built.game,
      this.#built.nodes,
      'panel' !== this.#commentary(),
    )
    for (const button of Array.from(moves.querySelectorAll('button[data-node]'))) {
      button.addEventListener('click', () => {
        this.#go(this.#built?.nodes[Number((button as HTMLElement).dataset.node)])
      })
    }
  }

  #commentary(): Commentary {
    const value = this.getAttribute('commentary')
    return 'panel' === value || 'hidden' === value ? value : 'inline'
  }

  #sourceMode(): Source {
    const value = this.getAttribute('source')
    return 'view' === value || 'edit' === value ? value : 'hidden'
  }

  /** Put `text` in the editor — unless the editor is where it came from. */
  #syncEditor(text: string) {
    const editor = this.#root.getElementById('src') as HTMLTextAreaElement | null
    if (null == editor) return
    editor.readOnly = 'edit' !== this.#sourceMode()
    // Writing the value back mid-keystroke would move the caret to the end.
    if (!this.#editing && editor.value !== text) editor.value = text
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

    const editor = this.#root.getElementById('src') as HTMLTextAreaElement
    editor.addEventListener('input', () => {
      // #editing is what tells load() that a half-typed game is expected,
      // that the caret must not be disturbed, and that the reader's place
      // is worth keeping.
      this.#editing = true
      this.#source = editor.value
      try {
        this.load()
      } finally {
        this.#editing = false
      }
    })

    if (!this.hasAttribute('tabindex')) this.tabIndex = 0
    this.addEventListener('keydown', (e: KeyboardEvent) => {
      // Typing in the editor is typing, not navigating: `f` has to insert
      // an f, and the arrow keys have to move the caret. The event is
      // retargeted to the host on its way out of the shadow root, so the
      // composed path is what says where it started.
      if (e.composedPath().includes(editor)) return

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

  /**
   * Fill the commentary panel for the position on screen.
   *
   * At the start of a line the commentary is the line's own — a comment
   * before the first move annotates the position it starts from, not the
   * move that follows it.
   */
  #comment() {
    const box = this.#root.getElementById('comment') as HTMLElement
    if ('panel' !== this.#commentary()) {
      box.textContent = ''
      return
    }

    const comments = this.#node ? this.#node.move.comments : this.#built?.game.comments
    const label = this.#node
      ? `${this.#node.move.number}${'w' === this.#node.move.side ? '.' : '…'} ${this.#node.move.san}`
      : ''

    const prose = proseOf(comments)
    const commands = commandsHtml(comments)
    if (0 === prose.length && '' === commands) {
      box.innerHTML = ''
      return
    }

    box.innerHTML =
      (label ? `<span class="who">${esc(label)}</span>` : '') +
      commands +
      prose.map((text) => `<p>${esc(text)}</p>`).join('')
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

    this.#comment()

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
export function define(name = 'chess-view') {
  if (!customElements.get(name)) customElements.define(name, ChessViewElement)
}
