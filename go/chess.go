/* Copyright (c) 2026 Richard Rodger, MIT License */

// Package tabnaschess is a Tabnas grammar plugin that parses chess
// notation: PGN (Portable Game Notation) games and the SAN (Standard
// Algebraic Notation) moves inside them.
//
// Example:
//
//	[Event "F/S Return Match"]
//	[Result "1/2-1/2"]
//
//	1. e4 e5 2. Nf3 {The main line.} Nc6 $1 (2... d6 3. d4) 1/2-1/2
//
// This is a port of the canonical TypeScript implementation. The grammar
// is not duplicated: both runtimes embed the same JSON, generated from
// chess-grammar.jsonic by ts/embed-grammar.js. See ../ts/doc/concepts.md
// for why the model and the grammar look the way they do.
package tabnaschess

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync"

	tabnas "github.com/tabnas/parser/go"
)

// VERSION is this module's version. It MUST equal ts/package.json
// "version": TestVersionMatchesPackageJSON fails the build if they drift.
const VERSION = "0.1.0"

// --- BEGIN EMBEDDED chess-grammar.jsonic ---
const grammarText = `
{
  "rule": {
    "pgn": {
      "open": [
        {
          "s": "#ZZ",
          "g": "pgn,empty"
        },
        {
          "s": "#HEAD",
          "p": "gameitem",
          "b": 1,
          "g": "pgn,game"
        }
      ],
      "close": [
        {
          "s": "#ZZ",
          "g": "pgn,end"
        }
      ]
    },
    "gameitem": {
      "open": [
        {
          "s": "#HEAD",
          "p": "game",
          "b": 1,
          "g": "game,item"
        }
      ],
      "close": [
        {
          "s": "#HEAD",
          "r": "gameitem",
          "b": 1,
          "g": "game,next"
        },
        {
          "s": "#ZZ",
          "g": "game,end"
        }
      ]
    },
    "game": {
      "open": [
        {
          "s": "#OS",
          "p": "tag",
          "b": 1,
          "g": "game,tag"
        },
        {
          "s": "#ELEM",
          "p": "movetext",
          "b": 1,
          "g": "game,movetext"
        },
        {
          "s": "#RES",
          "a": "@result-open",
          "g": "game,result"
        }
      ],
      "close": [
        {
          "s": "#OS",
          "p": "tag",
          "b": 1,
          "c": "@more-tags",
          "g": "game,tag"
        },
        {
          "s": "#ELEM",
          "p": "movetext",
          "b": 1,
          "c": "@no-result",
          "g": "game,movetext"
        },
        {
          "s": "#RES",
          "a": "@result-close",
          "g": "game,result"
        },
        {
          "s": "#ZZ",
          "g": "game,end"
        },
        {
          "b": 1,
          "g": "game,more"
        }
      ]
    },
    "tag": {
      "open": [
        {
          "s": "#OS",
          "p": "tagbody",
          "g": "tag,open"
        }
      ],
      "close": [
        {
          "s": "#CS",
          "g": "tag,close"
        }
      ]
    },
    "tagbody": {
      "open": [
        {
          "s": "#TGN #ST",
          "a": "@tag",
          "g": "tag,pair"
        }
      ],
      "close": [
        {
          "s": "#CS",
          "b": 1,
          "g": "tag,end"
        }
      ]
    },
    "movetext": {
      "open": [
        {
          "s": "#ELEM",
          "p": "element",
          "b": 1,
          "g": "movetext,elem"
        }
      ],
      "close": [
        {
          "s": "#EEND",
          "b": 1,
          "g": "movetext,end"
        },
        {
          "s": "#ZZ",
          "g": "movetext,end"
        },
        {
          "b": 1,
          "g": "movetext,more"
        }
      ]
    },
    "element": {
      "open": [
        {
          "s": "#SAN",
          "a": "@move",
          "g": "elem,move"
        },
        {
          "s": "#MVN",
          "a": "@number",
          "g": "elem,number"
        },
        {
          "s": "#NAG",
          "a": "@nag",
          "g": "elem,nag"
        },
        {
          "s": "#CMT",
          "a": "@brace-comment",
          "g": "elem,comment"
        },
        {
          "s": "#RMK",
          "a": "@line-comment",
          "g": "elem,comment"
        },
        {
          "s": "#OP",
          "p": "rav",
          "b": 1,
          "u": {
            "rav": true
          },
          "g": "elem,rav"
        }
      ],
      "close": [
        {
          "s": "#ELEM",
          "r": "element",
          "b": 1,
          "g": "elem,next"
        },
        {
          "s": "#EEND",
          "b": 1,
          "g": "elem,end"
        },
        {
          "s": "#ZZ",
          "g": "elem,end"
        },
        {
          "b": 1,
          "g": "elem,more"
        }
      ]
    },
    "rav": {
      "open": [
        {
          "s": "#OP",
          "p": "movetext",
          "g": "rav,open"
        }
      ],
      "close": [
        {
          "s": "#CP",
          "g": "rav,close"
        }
      ]
    },
    "move": {
      "open": [
        {
          "s": "#SAN",
          "a": "@bare-move",
          "g": "move,san"
        }
      ],
      "close": [
        {
          "s": "#ZZ",
          "g": "move,end"
        },
        {
          "b": 1,
          "g": "move,more"
        }
      ]
    }
  }
}`

// --- END EMBEDDED chess-grammar.jsonic ---

// --- The parse model -----------------------------------------------------

// Disambiguation is as much of a move's origin square as the notation
// states (PGN spec 8.2.3.4). Never inferred: a parser without a board
// cannot know the origin of `Nf3`.
type Disambiguation struct {
	File string `json:"file,omitempty"`
	Rank int    `json:"rank,omitempty"`
}

// Command is one [%name arg,arg] command inside a comment (a de facto
// extension, not part of the PGN standard).
type Command struct {
	Name string   `json:"name"`
	Args []string `json:"args"`
}

// Comment is a brace or rest-of-line comment (PGN spec 5). Text is the
// body verbatim, markup included.
type Comment struct {
	Kind     string     `json:"kind"`
	Text     string     `json:"text"`
	Commands []*Command `json:"commands,omitempty"`
}

// Move is one move, as written. A field the notation did not state is
// absent, never guessed — there is deliberately no From.
type Move struct {
	San            string          `json:"san"`
	Piece          string          `json:"piece"`
	Disambiguation *Disambiguation `json:"disambiguation,omitempty"`
	Capture        bool            `json:"capture,omitempty"`
	To             string          `json:"to,omitempty"`
	Promotion      string          `json:"promotion,omitempty"`
	Castle         string          `json:"castle,omitempty"`
	Check          string          `json:"check,omitempty"`
	Annotation     string          `json:"annotation,omitempty"`
	Number         int             `json:"number,omitempty"`
	Side           string          `json:"side,omitempty"`
	Nags           []int           `json:"nags,omitempty"`
	Comments       []*Comment      `json:"comments,omitempty"`
	Variations     []*Line         `json:"variations,omitempty"`
}

// Line is a move sequence: a game's mainline, or one variation.
//
// An annotation belongs to the move it follows. Comments, Nags and
// Variations here hold the ones that precede the line's first move and so
// have no move to belong to — they annotate the starting position.
type Line struct {
	Moves      []*Move    `json:"moves"`
	Comments   []*Comment `json:"comments,omitempty"`
	Nags       []int      `json:"nags,omitempty"`
	Variations []*Line    `json:"variations,omitempty"`

	// The running move number and side to move. Not part of the model:
	// bookkeeping the parse carries along the line.
	count *count `json:"-"`
}

// Game is a Line, plus the two things only a game has. The embedded Line
// is anonymous so its fields marshal into the same JSON object, mirroring
// the TypeScript `interface Game extends Line`.
type Game struct {
	Tags map[string]string `json:"tags"`
	Line
	Result string `json:"result,omitempty"`
}

// Database is a sequence of games (PGN spec 18).
type Database []*Game

// liner is what `movetext` and `element` write into: a game or a
// variation, uniformly.
type liner interface{ line() *Line }

func (l *Line) line() *Line { return l }
func (g *Game) line() *Line { return &g.Line }

// Options configures the plugin. The zero value is the default: import
// format, comment commands parsed, whole-database start rule.
type Options struct {
	// Strict requires export-format SAN (PGN spec 8.2.3.7): castling only
	// as O-O/O-O-O, no P pawn prefix, = before a promotion piece, no
	// !/? suffix annotations, and glyph values within 0..255.
	Strict bool

	// Commands parses [%name arg,arg] markup inside comments into
	// Comment.Commands. Defaults to true; set CommandsSet to turn it off.
	Commands bool

	// CommandsSet marks Commands as deliberately chosen, so that the zero
	// value of Options still means "parse commands".
	CommandsSet bool

	// Start selects the entry rule, and so what Parse returns:
	// "pgn" (default, Database), "game", "movetext" or "move".
	Start string
}

func (o Options) commands() bool {
	if o.CommandsSet {
		return o.Commands
	}
	return true
}

func (o Options) start() string {
	if "" == o.Start {
		return "pgn"
	}
	return o.Start
}

// --- Lexical definitions -------------------------------------------------

// PGN spec 7: a symbol token continues through these characters, so a
// token ending immediately before one has not really ended. Without this
// guard `e2e4` would lex as the two moves `e2` and `e4`.
//
// The TypeScript implementation writes this as a `(?!…)` lookahead inside
// the pattern. Go's RE2 has none, so here it is a bounds check the
// matcher runs after the match — same rule, checked one step later.
func isSymbolChar(c byte) bool {
	return ('A' <= c && c <= 'Z') || ('a' <= c && c <= 'z') ||
		('0' <= c && c <= '9') ||
		'_' == c || '+' == c || '#' == c || '=' == c || ':' == c || '-' == c
}

func endsToken(src string, end int, extra string) bool {
	if end >= len(src) {
		return true
	}
	c := src[end]
	if isSymbolChar(c) {
		return false
	}
	return !strings.ContainsRune(extra, rune(c))
}

// sanPattern builds the regexp that both LEXES a SAN move and TAKES IT
// APART, so the token boundary and the field values cannot disagree.
func sanPattern(strict bool) *regexp.Regexp {
	castle := "O-O-O|O-O|0-0-0|0-0"
	piece := "[KQRBNP]"
	promote := "=?"
	check := `\+\+|[+#]`
	annotation := `(?P<annotation>!!|\?\?|!\?|\?!|!|\?)?`
	if strict {
		castle = "O-O-O|O-O"
		piece = "[KQRBN]"
		promote = "="
		check = "[+#]"
		annotation = ""
	}
	return regexp.MustCompile(
		"^(?:" +
			"(?P<castle>" + castle + ")" +
			// Piece move: letter, optional disambiguation, optional capture, target.
			"|(?P<piece>" + piece + ")(?P<dfile>[a-h])?(?P<drank>[1-8])?" +
			"(?P<pcapture>x)?(?P<pto>[a-h][1-8])" +
			// Pawn move: origin file, optional capture, target rank, promotion.
			"|(?P<pfile>[a-h])(?:x(?P<pxfile>[a-h]))?(?P<prank>[1-8])" +
			"(?:" + promote + "(?P<promotion>[QRBN]))?" +
			")" +
			"(?P<check>" + check + ")?" +
			annotation,
	)
}

var (
	// Move number indication (8.2.2): digits, then zero or more periods,
	// with optional space between. The number starts at 1 — the indication
	// gives "the move number of the immediately following white move", and
	// there is no move zero — and nine digits is far past any real game,
	// which also stops an absurd literal reaching the number parser.
	moveNumber = regexp.MustCompile(`^[1-9][0-9]{0,8}(?:[ \t]*\.+)?`)

	// Numeric annotation glyph (8.2.4).
	nag = regexp.MustCompile(`^\$[0-9]{1,9}`)

	// Game termination marker (8.2.6).
	result = regexp.MustCompile(`^(?:1-0|0-1|1/2-1/2|\*)`)

	// Tag name (8.1): letters, digits and underscore only.
	tagName = regexp.MustCompile(`^[A-Za-z0-9_]+`)

	// [%name arg,arg] markup inside a comment.
	commandRe = regexp.MustCompile(`\[%([A-Za-z_][A-Za-z0-9_]*)(?:[ \t]+([^\]]*))?\]`)

	suffixRe = regexp.MustCompile(`(?:!!|\?\?|!\?|\?!|!|\?)$`)
	spaceRe  = regexp.MustCompile(`[ \t]+`)
)

// AnnotationNag is the glyph each traditional suffix annotation maps to
// (PGN spec 8.2.3.8 and 10). Exported so callers can normalise
// import-format annotations the way an export-format writer would.
var AnnotationNag = map[string]int{
	"!":  1,
	"?":  2,
	"!!": 3,
	"??": 4,
	"!?": 5,
	"?!": 6,
}

// StripCommands removes [%name ...] markup from a comment body, collapses
// the whitespace it leaves behind, and trims.
func StripCommands(text string) string {
	out := commandRe.ReplaceAllString(text, " ")
	return strings.TrimSpace(spaceRe.ReplaceAllString(out, " "))
}

// ParseSan takes a single SAN move string apart. It reports ok=false
// rather than erroring when src is not a move — the whole string must be
// one move, so a prefix match does not count.
func ParseSan(src string, opts ...Options) (*Move, bool) {
	var o Options
	if 0 < len(opts) {
		o = opts[0]
	}
	re := sanPattern(o.Strict)
	m := re.FindStringSubmatch(src)
	if nil == m || m[0] != src {
		return nil, false
	}
	return buildMove(re, m, m[0]), true
}

func groupOf(re *regexp.Regexp, m []string, name string) string {
	for i, n := range re.SubexpNames() {
		if n == name && i < len(m) {
			return m[i]
		}
	}
	return ""
}

func buildMove(re *regexp.Regexp, m []string, whole string) *Move {
	g := func(name string) string { return groupOf(re, m, name) }
	move := &Move{San: suffixRe.ReplaceAllString(whole, "")}

	switch {
	case "" != g("castle"):
		move.Piece = "K"
		move.Castle = "king"
		if 3 < len(g("castle")) {
			move.Castle = "queen"
		}

	case "" != g("piece"):
		move.Piece = g("piece")
		if "" != g("dfile") || "" != g("drank") {
			move.Disambiguation = &Disambiguation{File: g("dfile")}
			if "" != g("drank") {
				move.Disambiguation.Rank = atoi(g("drank"))
			}
		}
		move.Capture = "" != g("pcapture")
		move.To = g("pto")

	default:
		move.Piece = "P"
		if "" != g("pxfile") {
			move.Disambiguation = &Disambiguation{File: g("pfile")}
			move.Capture = true
			move.To = g("pxfile") + g("prank")
		} else {
			move.To = g("pfile") + g("prank")
		}
		move.Promotion = g("promotion")
	}

	// `++` is an old spelling of a double check; it is still just a check.
	if c := g("check"); "" != c {
		move.Check = "+"
		if "#" == c {
			move.Check = "#"
		}
	}
	move.Annotation = g("annotation")

	return move
}

func atoi(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}

// --- Hand-written lex matchers -------------------------------------------

// These three are registered in the lex.match registry rather than as
// match.token regexps, because they are not context-sensitive: `{`, `;`
// and a first-column `%` mean the same thing wherever they appear, and a
// hand-written matcher can keep the row/column counters honest across the
// newlines they may span.

func advance(pnt *tabnas.Point, src string) {
	lastLine := -1
	for i := 0; i < len(src); i++ {
		if '\n' == src[i] {
			pnt.RI++
			lastLine = i
		}
	}
	pnt.SI += len(src)
	if -1 == lastLine {
		pnt.CI += len(src)
	} else {
		pnt.CI = len(src) - lastLine
	}
}

func lineFrom(src string, start int) string {
	end := start
	for end < len(src) && '\n' != src[end] && '\r' != src[end] {
		end++
	}
	return src[start:end]
}

func makeCommentMatcher(tin tabnas.Tin) tabnas.MakeLexMatcher {
	return func(_ *tabnas.LexConfig, _ *tabnas.Options) tabnas.LexMatcher {
		return func(lex *tabnas.Lex, _ *tabnas.Rule) *tabnas.Token {
			pnt := lex.Cursor()
			src := lex.Src
			if pnt.SI >= len(src) || '{' != src[pnt.SI] {
				return nil
			}

			rel := strings.IndexByte(src[pnt.SI+1:], '}')
			if 0 > rel {
				return badToken(lex, "unterminated_comment", src, pnt.SI, len(src))
			}
			end := pnt.SI + 1 + rel

			tsrc := src[pnt.SI : end+1]
			tkn := lex.Token("#CMT", tin, tsrc[1:len(tsrc)-1], tsrc)
			advance(pnt, tsrc)
			return tkn
		}
	}
}

func makeRemarkMatcher(tin tabnas.Tin) tabnas.MakeLexMatcher {
	return func(_ *tabnas.LexConfig, _ *tabnas.Options) tabnas.LexMatcher {
		return func(lex *tabnas.Lex, _ *tabnas.Rule) *tabnas.Token {
			pnt := lex.Cursor()
			src := lex.Src
			if pnt.SI >= len(src) || ';' != src[pnt.SI] {
				return nil
			}

			tsrc := lineFrom(src, pnt.SI)
			tkn := lex.Token("#RMK", tin, tsrc[1:], tsrc)
			advance(pnt, tsrc)
			return tkn
		}
	}
}

// PGN spec 6: a `%` in the FIRST column escapes the rest of the line for
// private use. A `%` anywhere else is an ordinary character.
func makeEscapeMatcher() tabnas.MakeLexMatcher {
	return func(_ *tabnas.LexConfig, _ *tabnas.Options) tabnas.LexMatcher {
		return func(lex *tabnas.Lex, _ *tabnas.Rule) *tabnas.Token {
			pnt := lex.Cursor()
			src := lex.Src
			if 1 != pnt.CI || pnt.SI >= len(src) || '%' != src[pnt.SI] {
				return nil
			}

			tsrc := lineFrom(src, pnt.SI)
			// #CM is in the IGNORE token set, so the parser never sees it.
			tkn := lex.Token("#CM", tabnas.TinCM, nil, tsrc)
			advance(pnt, tsrc)
			return tkn
		}
	}
}

// --- Match-token matchers ------------------------------------------------

// These four are the gated matchers: the engine only runs them where an
// active alternate names their token, which is what makes `Event` a tag
// name inside `[…]` and a lex error in the movetext.
//
// They are functions rather than plain regexps only because each needs a
// bounds check RE2 cannot express as a lookahead. `#TGN` needs none and
// stays a regexp.

// tokenAt runs re at the cursor and, if accept agrees, emits a token of
// exactly the accepted length.
func tokenAt(
	name string,
	tin tabnas.Tin,
	re *regexp.Regexp,
	accept func(src string, start int, m []string) (string, bool),
) tabnas.LexMatcher {
	return func(lex *tabnas.Lex, _ *tabnas.Rule) *tabnas.Token {
		pnt := lex.Cursor()
		if pnt.SI >= len(lex.Src) {
			return nil
		}
		m := re.FindStringSubmatch(lex.Src[pnt.SI:])
		if nil == m {
			return nil
		}
		tsrc, ok := accept(lex.Src, pnt.SI, m)
		if !ok || "" == tsrc {
			return nil
		}
		tkn := lex.Token(name, tin, nil, tsrc)
		advance(pnt, tsrc)
		return tkn
	}
}

func makeSanMatcher(tin tabnas.Tin, re *regexp.Regexp) tabnas.LexMatcher {
	return tokenAt("#SAN", tin, re, func(src string, start int, m []string) (string, bool) {
		return m[0], endsToken(src, start+len(m[0]), "")
	})
}

// A number written WITHOUT periods must still end its symbol token (spec
// 7), or `12e4` would lex as move number 12 plus the move e4 rather than
// as the one bad token it is — and that also keeps the `1` of a `1-0` or
// `1/2-1/2` termination marker out.
func makeMoveNumberMatcher(tin tabnas.Tin) tabnas.LexMatcher {
	return tokenAt("#MVN", tin, moveNumber, func(src string, start int, m []string) (string, bool) {
		if strings.Contains(m[0], ".") {
			return m[0], true
		}
		return m[0], endsToken(src, start+len(m[0]), "/")
	})
}

// Three of the four markers are symbol tokens and so must end at a
// non-symbol character; the asterisk "is a token by itself... It is self
// terminating" (spec 7), which is what lets `*1. e4` close one game and
// open the next.
func makeResultMatcher(tin tabnas.Tin) tabnas.LexMatcher {
	return tokenAt("#RES", tin, result, func(src string, start int, m []string) (string, bool) {
		if "*" == m[0] {
			return m[0], true
		}
		return m[0], endsToken(src, start+len(m[0]), "/")
	})
}

// 8.2.4: a glyph value is from zero to 255. Import format is not fussy
// about that; export format is.
func makeNagMatcher(tin tabnas.Tin, strict bool) tabnas.LexMatcher {
	return tokenAt("#NAG", tin, nag, func(src string, start int, m []string) (string, bool) {
		if strict {
			n, err := strconv.Atoi(m[0][1:])
			if nil != err || 255 < n {
				return "", false
			}
		}
		return m[0], true
	})
}

func badToken(lex *tabnas.Lex, code, src string, start, end int) *tabnas.Token {
	if end > len(src) {
		end = len(src)
	}
	if end <= start {
		end = start + 1
		if end > len(src) {
			end = len(src)
		}
	}
	tkn := lex.Token("#BD", tabnas.TinBD, nil, src[start:end])
	tkn.Err = code
	tkn.Why = code
	return tkn
}

// --- Grammar actions -----------------------------------------------------

type count struct {
	number int
	side   string
}

func lineOf(r *tabnas.Rule) *Line {
	if lh, ok := r.Node.(liner); ok {
		return lh.line()
	}
	return nil
}

// counter returns the line's running move number and side, seeding it on
// first use. A game with a FEN tag does not start at move 1 with White to
// move, and PGN spec 9.7 says that tag is where to look: fields 2 and 6 of
// a FEN record are the active colour and the fullmove number.
func counter(node any) *count {
	lh, ok := node.(liner)
	if !ok {
		return &count{number: 1, side: "w"}
	}
	l := lh.line()
	if nil != l.count {
		return l.count
	}
	c := &count{number: 1, side: "w"}
	if g, ok := node.(*Game); ok {
		if fen, has := g.Tags["FEN"]; has {
			field := strings.Fields(fen)
			if 2 <= len(field) && "b" == field[1] {
				c.side = "b"
			}
			if 6 <= len(field) {
				if n, err := strconv.Atoi(field[5]); nil == err && 0 < n {
					c.number = n
				}
			}
		}
	}
	l.count = c
	return c
}

func annotateComment(r *tabnas.Rule, c *Comment) {
	l := lineOf(r)
	if nil == l {
		return
	}
	if 0 < len(l.Moves) {
		m := l.Moves[len(l.Moves)-1]
		m.Comments = append(m.Comments, c)
		return
	}
	l.Comments = append(l.Comments, c)
}

func annotateNag(r *tabnas.Rule, n int) {
	l := lineOf(r)
	if nil == l {
		return
	}
	if 0 < len(l.Moves) {
		m := l.Moves[len(l.Moves)-1]
		m.Nags = append(m.Nags, n)
		return
	}
	l.Nags = append(l.Nags, n)
}

func makeComment(kind, text string, parse bool) *Comment {
	c := &Comment{Kind: kind, Text: text}
	if !parse {
		return c
	}
	for _, m := range commandRe.FindAllStringSubmatch(text, -1) {
		args := []string{}
		for _, a := range strings.Split(m[2], ",") {
			if a = strings.TrimSpace(a); "" != a {
				args = append(args, a)
			}
		}
		c.Commands = append(c.Commands, &Command{Name: m[1], Args: args})
	}
	return c
}

func decompose(re *regexp.Regexp, src string) *Move {
	m := re.FindStringSubmatch(src)
	if nil == m {
		return &Move{San: src}
	}
	return buildMove(re, m, src)
}

func refs(san *regexp.Regexp, commands bool) map[tabnas.FuncRef]any {
	return map[tabnas.FuncRef]any{
		// The database is held behind a pointer: a Go slice is a value, so
		// `gameitem` appending to its inherited node would otherwise
		// append to a copy and `pgn` would end with nothing.
		"@pgn-bo": tabnas.StateAction(func(r *tabnas.Rule, _ *tabnas.Context) {
			r.Node = &Database{}
		}),

		"@gameitem-bc": tabnas.StateAction(func(r *tabnas.Rule, _ *tabnas.Context) {
			g, ok := r.Child.Node.(*Game)
			if !ok || nil == g {
				return
			}
			if db, ok := r.Node.(*Database); ok {
				*db = append(*db, g)
			}
		}),

		"@game-bo": tabnas.StateAction(func(r *tabnas.Rule, _ *tabnas.Context) {
			r.Node = &Game{Tags: map[string]string{}, Line: Line{Moves: []*Move{}}}
		}),

		// `movetext` normally inherits the enclosing line and writes into
		// it. As a start rule it has no parent, so it allocates one.
		"@movetext-bo": tabnas.StateAction(func(r *tabnas.Rule, _ *tabnas.Context) {
			if nil == r.Node {
				r.Node = &Line{Moves: []*Move{}}
			}
		}),

		"@tag": tabnas.AltAction(func(r *tabnas.Rule, _ *tabnas.Context) {
			g, ok := r.Node.(*Game)
			if !ok {
				return
			}
			name := r.O0.Src
			// PGN spec 8.1: a tag name should not repeat; the first wins,
			// as a reader has no better rule for choosing between them.
			if _, has := g.Tags[name]; !has {
				g.Tags[name] = fmt.Sprint(r.O1.Val)
			}
		}),

		"@result-open": tabnas.AltAction(func(r *tabnas.Rule, _ *tabnas.Context) {
			if g, ok := r.Node.(*Game); ok {
				g.Result = r.O0.Src
			}
		}),

		"@result-close": tabnas.AltAction(func(r *tabnas.Rule, _ *tabnas.Context) {
			if g, ok := r.Node.(*Game); ok {
				g.Result = r.C0.Src
			}
		}),

		// A `[` after the movetext has started belongs to the next game,
		// not to this one's tag section.
		"@more-tags": tabnas.AltCond(func(r *tabnas.Rule, _ *tabnas.Context) bool {
			g, ok := r.Node.(*Game)
			if !ok {
				return true
			}
			return 0 == len(g.Moves) && "" == g.Result
		}),

		// PGN spec 8.2.6: the termination marker is the last element of a
		// movetext section, so movetext after one belongs to the next game.
		// This is what lets `*1. e4 *` be two games.
		"@no-result": tabnas.AltCond(func(r *tabnas.Rule, _ *tabnas.Context) bool {
			g, ok := r.Node.(*Game)
			return !ok || "" == g.Result
		}),

		"@move": tabnas.AltAction(func(r *tabnas.Rule, _ *tabnas.Context) {
			l := lineOf(r)
			if nil == l {
				return
			}
			c := counter(r.Node)
			move := decompose(san, r.O0.Src)
			move.Number = c.number
			move.Side = c.side
			if "w" == c.side {
				c.side = "b"
			} else {
				c.side = "w"
				c.number++
			}
			l.Moves = append(l.Moves, move)
		}),

		"@bare-move": tabnas.AltAction(func(r *tabnas.Rule, _ *tabnas.Context) {
			r.Node = decompose(san, r.O0.Src)
		}),

		// PGN spec 8.2.2: the integer is the fullmove number of the move
		// that follows. Import format allows any number of periods, but
		// three or more is the export-format spelling for "Black to move",
		// so it is worth honouring where it appears.
		"@number": tabnas.AltAction(func(r *tabnas.Rule, _ *tabnas.Context) {
			c := counter(r.Node)
			src := r.O0.Src
			digits := 0
			for digits < len(src) && '0' <= src[digits] && src[digits] <= '9' {
				digits++
			}
			c.number = atoi(src[:digits])
			dots := strings.Count(src, ".")
			if 1 == dots {
				c.side = "w"
			} else if 1 < dots {
				c.side = "b"
			}
		}),

		"@nag": tabnas.AltAction(func(r *tabnas.Rule, _ *tabnas.Context) {
			annotateNag(r, atoi(r.O0.Src[1:]))
		}),

		"@brace-comment": tabnas.AltAction(func(r *tabnas.Rule, _ *tabnas.Context) {
			annotateComment(r, makeComment("brace", fmt.Sprint(r.O0.Val), commands))
		}),

		"@line-comment": tabnas.AltAction(func(r *tabnas.Rule, _ *tabnas.Context) {
			annotateComment(r, makeComment("line", fmt.Sprint(r.O0.Val), commands))
		}),

		// A variation replaces the move it follows, so it starts on that
		// move's number and side, not on the next one.
		"@rav-bo": tabnas.StateAction(func(r *tabnas.Rule, _ *tabnas.Context) {
			line := &Line{Moves: []*Move{}}
			parent := lineOf(r.Parent)
			if nil != parent && 0 < len(parent.Moves) {
				prev := parent.Moves[len(parent.Moves)-1]
				line.count = &count{number: prev.Number, side: prev.Side}
			} else {
				c := counter(r.Parent.Node)
				line.count = &count{number: c.number, side: c.side}
			}
			r.Node = line
		}),

		"@element-bc": tabnas.StateAction(func(r *tabnas.Rule, _ *tabnas.Context) {
			if true != r.U["rav"] {
				return
			}
			variation, ok := r.Child.Node.(*Line)
			if !ok {
				return
			}
			l := lineOf(r)
			if nil == l {
				return
			}
			// A variation replaces the move it follows; one that follows no
			// move annotates the line's starting position instead.
			if 0 < len(l.Moves) {
				m := l.Moves[len(l.Moves)-1]
				m.Variations = append(m.Variations, variation)
				return
			}
			l.Variations = append(l.Variations, variation)
		}),
	}
}

// --- The grammar ---------------------------------------------------------

// The embedded grammar is data, so it is decoded rather than rebuilt. The
// alternate fields are declared concretely (rather than into `any`) so a
// JSON number cannot arrive as a float64 where the engine wants an int.
type altJSON struct {
	S string         `json:"s"`
	B int            `json:"b"`
	P string         `json:"p"`
	R string         `json:"r"`
	A string         `json:"a"`
	C string         `json:"c"`
	U map[string]any `json:"u"`
	G string         `json:"g"`
}

type ruleJSON struct {
	Open  []*altJSON `json:"open"`
	Close []*altJSON `json:"close"`
}

func (a *altJSON) spec() *tabnas.GrammarAltSpec {
	alt := &tabnas.GrammarAltSpec{P: a.P, R: a.R, G: a.G, U: a.U}
	if "" != a.S {
		alt.S = a.S
	}
	if 0 != a.B {
		alt.B = a.B
	}
	if "" != a.A {
		alt.A = a.A
	}
	if "" != a.C {
		alt.C = a.C
	}
	return alt
}

// buildGrammar decodes the embedded JSON, keeping the rule order the
// grammar source declared — a Go map has none, and the engine reports
// rule order from GrammarSpec.RuleOrder.
func buildGrammar(ref map[tabnas.FuncRef]any) (*tabnas.GrammarSpec, error) {
	var doc struct {
		Rule map[string]*ruleJSON `json:"rule"`
	}
	if err := json.Unmarshal([]byte(grammarText), &doc); nil != err {
		return nil, fmt.Errorf("chess: embedded grammar is not valid JSON: %w", err)
	}
	if 0 == len(doc.Rule) {
		return nil, fmt.Errorf("chess: embedded grammar has no rules")
	}

	order, err := ruleOrder(grammarText)
	if nil != err {
		return nil, err
	}

	gs := &tabnas.GrammarSpec{
		Ref:       ref,
		Rule:      map[string]*tabnas.GrammarRuleSpec{},
		RuleOrder: order,
	}
	for name, rule := range doc.Rule {
		spec := &tabnas.GrammarRuleSpec{}
		if 0 < len(rule.Open) {
			alts := make([]*tabnas.GrammarAltSpec, len(rule.Open))
			for i, a := range rule.Open {
				alts[i] = a.spec()
			}
			spec.Open = alts
		}
		if 0 < len(rule.Close) {
			alts := make([]*tabnas.GrammarAltSpec, len(rule.Close))
			for i, a := range rule.Close {
				alts[i] = a.spec()
			}
			spec.Close = alts
		}
		gs.Rule[name] = spec
	}
	return gs, nil
}

// ruleOrder reads the `rule` object's keys in source order, which
// encoding/json discards when it builds a map.
func ruleOrder(text string) ([]string, error) {
	var doc map[string]json.RawMessage
	if err := json.Unmarshal([]byte(text), &doc); nil != err {
		return nil, fmt.Errorf("chess: embedded grammar is not valid JSON: %w", err)
	}
	raw, has := doc["rule"]
	if !has {
		return nil, fmt.Errorf("chess: embedded grammar has no rule table")
	}

	dec := json.NewDecoder(strings.NewReader(string(raw)))
	if _, err := dec.Token(); nil != err { // opening '{'
		return nil, err
	}
	order := []string{}
	for dec.More() {
		key, err := dec.Token()
		if nil != err {
			return nil, err
		}
		name, ok := key.(string)
		if !ok {
			return nil, fmt.Errorf("chess: embedded grammar has a non-string rule name")
		}
		order = append(order, name)
		var skip json.RawMessage
		if err := dec.Decode(&skip); nil != err {
			return nil, err
		}
	}
	return order, nil
}

// --- The plugin ----------------------------------------------------------

// Chess installs the chess-notation grammar on a bare Tabnas engine.
// Options are read from the plugin option map; Make is the typed way in.
func Chess(j *tabnas.Tabnas, options map[string]any) error {
	o := optionsFromMap(options)
	san := sanPattern(o.Strict)

	// Mint the tins before the matchers close over them. The ORDER is
	// load-bearing: match-token matchers run in Tin-ascending order, so
	// `#RES` must come before `#MVN` or the `1` of `1-0` lexes as a move
	// number. (TokenOrder below says the same thing for the regexp-form
	// entries; these are minted by hand because the hand-written matchers
	// need the Tin values.)
	tRES := j.Token("#RES")
	tSAN := j.Token("#SAN")
	tMVN := j.Token("#MVN")
	tNAG := j.Token("#NAG")
	tCMT := j.Token("#CMT")
	tRMK := j.Token("#RMK")

	boolPtr := func(b bool) *bool { return &b }
	strPtr := func(s string) *string { return &s }

	opts := &tabnas.Options{
		// PGN's brackets are not JSON's: `[` `]` delimit tag pairs, `(`
		// `)` delimit variations, and `{` `}` are comment markers handled
		// by a matcher, so the JSON-shaped fixed tokens are retired.
		Fixed: &tabnas.FixedOptions{
			Token: map[string]*string{
				"#OB": nil,
				"#CB": nil,
				"#CL": nil,
				"#CA": nil,
				"#OS": strPtr("["),
				"#CS": strPtr("]"),
				"#OP": strPtr("("),
				"#CP": strPtr(")"),
			},
		},

		Match: &tabnas.MatchOptions{
			Lex:   boolPtr(true),
			Token: map[string]*regexp.Regexp{"#TGN": tagName},
			TokenFn: map[string]tabnas.LexMatcher{
				"#RES": makeResultMatcher(tRES),
				"#SAN": makeSanMatcher(tSAN, san),
				"#MVN": makeMoveNumberMatcher(tMVN),
				"#NAG": makeNagMatcher(tNAG, o.Strict),
			},
			// Order matters: `#RES` is tried before `#MVN` so the `1` of
			// `1-0` is never mistaken for a move number.
			TokenOrder: []string{"#RES", "#SAN", "#MVN", "#NAG", "#TGN"},
		},

		Lex: &tabnas.LexOptions{
			Match: map[string]*tabnas.MatchSpec{
				"pgnComment": {Order: 1200000, Make: makeCommentMatcher(tCMT)},
				"pgnRemark":  {Order: 1300000, Make: makeRemarkMatcher(tRMK)},
				"pgnEscape":  {Order: 1500000, Make: makeEscapeMatcher()},
			},
			EmptyResult: &Database{},
		},

		TokenSet: map[string][]string{
			// What may start a movetext element.
			"ELEM": {"#SAN", "#MVN", "#NAG", "#CMT", "#RMK", "#OP"},
			// What may start a game: a tag pair, an element, or a result.
			"HEAD": {"#OS", "#SAN", "#MVN", "#NAG", "#CMT", "#RMK", "#OP", "#RES"},
			// What ends an element sequence, to be re-read by an outer rule.
			"EEND": {"#RES", "#OS", "#CP"},
		},

		// Every lexical atom of PGN has its own matcher above; a bareword
		// or a bare number outside them is not chess notation.
		Text:   &tabnas.TextOptions{Lex: boolPtr(false)},
		Number: &tabnas.NumberOptions{Lex: boolPtr(false)},
		// PGN's own comment styles are tokens this grammar keeps, not
		// whitespace the lexer may discard.
		Comment: &tabnas.CommentOptions{Lex: boolPtr(false)},
		Value:   &tabnas.ValueOptions{Lex: boolPtr(false)},

		// PGN spec 7: a tag value is double-quoted, on one line, and the
		// only escapes are \" and \\.
		String: &tabnas.StringOptions{
			Chars:        `"`,
			MultiChars:   "",
			EscapeStrict: boolPtr(true),
			Escape: map[string]string{
				"n": "", "t": "", "r": "", "b": "", "f": "", "v": "", "0": "",
			},
			AllowUnknown: boolPtr(true),
		},

		Rule: &tabnas.RuleOptions{Start: o.start()},
	}

	gs, err := buildGrammar(refs(san, o.commands()))
	if nil != err {
		return err
	}
	gs.Options = opts

	setting := &tabnas.GrammarSetting{
		Rule: &tabnas.GrammarSettingRule{
			Alt: &tabnas.GrammarSettingAlt{G: "chess"},
		},
	}
	return j.Grammar(gs, setting)
}

func optionsFromMap(m map[string]any) Options {
	o := Options{}
	if nil == m {
		return o
	}
	if v, has := m["strict"]; has {
		o.Strict, _ = v.(bool)
	}
	if v, has := m["commands"]; has {
		if b, ok := v.(bool); ok {
			o.Commands, o.CommandsSet = b, true
		}
	}
	if v, has := m["start"]; has {
		o.Start, _ = v.(string)
	}
	return o
}

func (o Options) toMap() map[string]any {
	m := map[string]any{"strict": o.Strict, "start": o.start()}
	if o.CommandsSet {
		m["commands"] = o.Commands
	}
	return m
}

// --- Convenience entry points --------------------------------------------

var (
	defaultOnce   sync.Once
	defaultParser *tabnas.Tabnas
)

// Make builds a Tabnas engine with the chess grammar installed. Reuse the
// result: building the grammar dominates a parse.
func Make(opts ...Options) *tabnas.Tabnas {
	var o Options
	if 0 < len(opts) {
		o = opts[0]
	}
	j := tabnas.Make()
	j.SetPluginOptions("chess", o.toMap())
	if err := Chess(j, o.toMap()); nil != err {
		panic(err)
	}
	return j
}

// Parse reads a PGN database (zero or more games). Start is forced to
// "pgn": this function parses a database, and its return type says so. Use
// Make for another entry rule.
//
// The cached parser is read only AFTER defaultOnce.Do, so a first
// concurrent call cannot race the initializer's write.
func Parse(src string, opts ...Options) (Database, error) {
	var j *tabnas.Tabnas
	if 0 == len(opts) {
		defaultOnce.Do(func() { defaultParser = Make() })
		j = defaultParser
	} else {
		o := opts[0]
		o.Start = "pgn"
		j = Make(o)
	}

	out, err := j.Parse(src)
	if nil != err {
		return nil, err
	}
	db, ok := out.(*Database)
	if !ok {
		return nil, fmt.Errorf("chess: unexpected parse result %T", out)
	}
	return *db, nil
}

// ParseGame reads the first game of src, or nil if there is none. As with
// Parse, the start rule is always "pgn".
func ParseGame(src string, opts ...Options) (*Game, error) {
	db, err := Parse(src, opts...)
	if nil != err {
		return nil, err
	}
	if 0 == len(db) {
		return nil, nil
	}
	return db[0], nil
}
