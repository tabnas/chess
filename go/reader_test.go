/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// A parse from a reader (Tabnas.ParseReader, admin ADR-30). Make declares
// lex.window, so a database is read a window of the source at a time, and
// the plugin's matchers read the text only through the window, each
// filling it as far as it reads (chess.go, "Reading through the window").
// Every row of the shared fixtures parses the same from a reader as from
// its text, handed over in pieces of 1, 3 and 64 bytes: the same value,
// tokens and rule passes, and an error's code, position, row and column.
//
// Go's window is 64 KiB, with no hook to make it smaller, so its edge is
// proven on a long database: its tokens of every kind straddle the 64 KiB
// boundaries, and its comments, remarks, escapes, tag values, tag names
// and move numbers longer than a window go past them, handed over in
// pieces of several sizes. ts/test/reader.test.ts and
// rs/tests/reader_test.rs are its twins.

package tabnaschess

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
	"testing"

	tabnas "github.com/tabnas/parser/go"
)

// pieces is a reader that hands its bytes over at most size at a time.
type pieces struct {
	bytes []byte
	at    int
	size  int
}

func (p *pieces) Read(buf []byte) (int, error) {
	if p.at >= len(p.bytes) {
		return 0, io.EOF
	}
	n := min(p.size, len(buf), len(p.bytes)-p.at)
	copy(buf, p.bytes[p.at:p.at+n])
	p.at += n
	return n, nil
}

// readerSpan is a token's name, position and length, in bytes.
type readerSpan struct {
	name   string
	si, by int
}

type readerLog struct {
	tokens, rules []string
	spans         []readerSpan
}

// recorded is j, recording the tokens and rule passes of each parse into
// log, and each token's name, position and length.
func recorded(j *tabnas.Tabnas, log *readerLog) *tabnas.Tabnas {
	j.Sub(func(tkn *tabnas.Token, rule *tabnas.Rule, ctx *tabnas.Context) {
		log.tokens = append(log.tokens, fmt.Sprintf("%s %q %v %d %d:%d",
			tkn.Name, tkn.Src, tkn.ResolveVal(rule, ctx), tkn.SI, tkn.RI, tkn.CI))
		log.spans = append(log.spans, readerSpan{tkn.Name, tkn.SI, len(tkn.Src)})
	}, nil)
	j.SubRuleDone(func(rule *tabnas.Rule, _ *tabnas.Context, done tabnas.RuleDone) {
		log.rules = append(log.rules, fmt.Sprintf("%s %s", rule.Name, done.State))
	})
	return j
}

type readerSeen struct {
	outcome       string
	tokens, rules []string
	spans         []readerSpan
}

// seenOf is what a parse showed: its value, or its error's code, position,
// row, column and token (not its excerpt, which a window may cut); and its
// tokens and passes, taken from log, which is empty again after.
func seenOf(t *testing.T, log *readerLog, parse func() (any, error)) readerSeen {
	t.Helper()
	var s readerSeen
	value, err := parse()
	var je *tabnas.TabnasError
	switch {
	case nil == err:
		encoded, merr := json.Marshal(value)
		if nil != merr {
			t.Fatalf("the value does not encode: %v", merr)
		}
		s.outcome = "ok " + string(encoded)
	case errors.As(err, &je):
		raw, merr := json.Marshal(je)
		if nil != merr {
			t.Fatalf("the diagnostic does not encode: %v", merr)
		}
		var d struct {
			Code  string `json:"code"`
			Pos   int    `json:"pos"`
			Row   int    `json:"row"`
			Col   int    `json:"col"`
			Token struct {
				Name string `json:"name"`
				Src  string `json:"src"`
			} `json:"token"`
		}
		if uerr := json.Unmarshal(raw, &d); nil != uerr {
			t.Fatalf("the diagnostic does not decode: %v", uerr)
		}
		s.outcome = fmt.Sprintf("err %s at %d %d:%d %s %q",
			d.Code, d.Pos, d.Row, d.Col, d.Token.Name, d.Token.Src)
	default:
		s.outcome = "error " + err.Error()
	}
	s.tokens, s.rules, s.spans = log.tokens, log.rules, log.spans
	log.tokens, log.rules, log.spans = nil, nil, nil
	return s
}

func sameSeen(t *testing.T, at string, read, whole readerSeen) {
	t.Helper()
	if read.outcome != whole.outcome {
		t.Fatalf("%s:\nread:  %.300s\nwhole: %.300s", at, read.outcome, whole.outcome)
	}
	if len(read.tokens) != len(whole.tokens) {
		t.Fatalf("%s: %d tokens read, %d whole", at, len(read.tokens), len(whole.tokens))
	}
	for i := range whole.tokens {
		if read.tokens[i] != whole.tokens[i] {
			t.Fatalf("%s: token %d:\nread:  %.300s\nwhole: %.300s", at, i, read.tokens[i], whole.tokens[i])
		}
	}
	if len(read.rules) != len(whole.rules) {
		t.Fatalf("%s: %d rule passes read, %d whole", at, len(read.rules), len(whole.rules))
	}
	for i := range whole.rules {
		if read.rules[i] != whole.rules[i] {
			t.Fatalf("%s: rule pass %d: read %s, whole %s", at, i, read.rules[i], whole.rules[i])
		}
	}
}

func TestMakeDeclaresTheWindow(t *testing.T) {
	if !Make().Config().Window {
		t.Fatal("Make does not declare lex.window")
	}
	if !Make(Options{Start: "move", Strict: true}).Config().Window {
		t.Fatal("Make with options does not declare lex.window")
	}
	// The plugin leaves the window to the engine its caller configures.
	j := tabnas.Make()
	if err := Chess(j, nil); nil != err {
		t.Fatal(err)
	}
	if j.Config().Window {
		t.Fatal("the plugin declares lex.window")
	}
}

func TestEveryFixtureParsesTheSameFromAReader(t *testing.T) {
	entries, err := os.ReadDir(specDir)
	if nil != err {
		t.Fatalf("cannot read %s: %v", specDir, err)
	}
	files := []string{}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tsv") {
			files = append(files, e.Name())
		}
	}
	sort.Strings(files)

	compared := 0
	for _, file := range files {
		for _, row := range loadSpec(t, file) {
			log := &readerLog{}
			j := recorded(Make(optionsFromJSON(t, row.opts)), log)
			whole := seenOf(t, log, func() (any, error) { return j.Parse(row.input) })
			for _, size := range []int{1, 3, 64} {
				read := seenOf(t, log, func() (any, error) {
					return j.ParseReader(&pieces{bytes: []byte(row.input), size: size})
				})
				sameSeen(t, fmt.Sprintf("%s:%d in pieces of %d", file, row.line, size), read, whole)
				compared++
			}
		}
	}
	if compared < 800 {
		t.Fatalf("compared %d", compared)
	}
}

func TestALongDatabaseParsesTheSameFromAReader(t *testing.T) {
	text := longDatabase()
	log := &readerLog{}
	j := recorded(Make(), log)
	whole := seenOf(t, log, func() (any, error) { return j.Parse(text) })
	if !strings.HasPrefix(whole.outcome, "ok ") {
		t.Fatalf("the long database does not parse: %.300s", whole.outcome)
	}
	straddles(t, text, whole.spans)

	for _, size := range []int{64, 1021, 4096, 64 << 10, 100_000} {
		read := seenOf(t, log, func() (any, error) {
			return j.ParseReader(&pieces{bytes: []byte(text), size: size})
		})
		sameSeen(t, fmt.Sprintf("in pieces of %d", size), read, whole)
	}
}

func TestACommentLeftOpenAtTheEndFailsWhereItsTextDoes(t *testing.T) {
	text := longDatabase() + "1. e4 {never closed " + line(long)
	log := &readerLog{}
	j := Make()
	whole := seenOf(t, log, func() (any, error) { return j.Parse(text) })
	if !strings.HasPrefix(whole.outcome, "err unterminated_comment at ") {
		t.Fatalf("not an unterminated comment: %.200s", whole.outcome)
	}
	for _, size := range []int{4096, 64 << 10} {
		read := seenOf(t, log, func() (any, error) {
			return j.ParseReader(&pieces{bytes: []byte(text), size: size})
		})
		if read.outcome != whole.outcome {
			t.Fatalf("in pieces of %d:\nread:  %.300s\nwhole: %.300s", size, read.outcome, whole.outcome)
		}
	}
}

// --- A long database ------------------------------------------------------

const (
	// The window's fixed margin and block, in bytes.
	boundary = 64 << 10
	// Longer than a window.
	long = 70_000
)

// filler is a game of the kind a database is mostly made of: tag pairs,
// comments with markup, a glyph, a variation, a rest-of-line comment, an
// escape and a termination marker, with characters past ASCII among them.
func filler(i int) string {
	return fmt.Sprintf("[Event \"Filler %d ñ\"]\n[Site \"Göteborg ♞\"]\n[Round \"%d\"]\n[Result \"1-0\"]\n\n", i, i) +
		"1. e4 e5 2. Nf3 {[%clk 0:03:00] the main line 𝄞} Nc6 $1 (2... d6 3. d4 exd4) " +
		"3. Bb5 a6 ; a remark é\n% private data\n4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 " +
		"7. Bb3 d6 8. c3 O-O 9. h3 Na5 10. Bc2 c5 11. d4 Qc7 12. Nbd2 cxd4 1-0\n\n"
}

// probes are games that each hold a token of one kind at a known place in
// their text: the token's name, the game, and where the token starts.
var probes = []struct {
	name string
	game string
	at   int
}{
	{"#TGN", "[WhiteElo \"2700\"]\n\n1. d4 d5 1-0\n\n", 1},
	{"#ST", "[Event \"Probe ñ\"]\n\n1. d4 d5 1-0\n\n", 7},
	{"#MVN", "12... Nf6 13. Nbd2 *\n\n", 0},
	{"#SAN", "1. Nbxd2+ e5 *\n\n", 3},
	{"#NAG", "1. e4 $123 e5 *\n\n", 6},
	{"#RES", "1. e4 e5 1/2-1/2\n\n", 9},
	{"#CMT", "1. e4 {a comment ñ\nover two lines} e5 *\n\n", 6},
	{"#RMK", "1. e4 ; a remark ñ\ne5 *\n\n", 6},
	{"#CM", "% an escape line\n1. e4 e5 *\n\n", 0},
	{"#SP", "1. e4      e5 *\n\n", 5},
	{"#LN", "1. e4\r\ne5 *\r\n\r\n", 5},
}

// repeated is at least n bytes of whole copies of unit.
func repeated(unit string, n int) string {
	return strings.Repeat(unit, (n+len(unit)-1)/len(unit))
}

// line is text of at least n bytes with no line break, quote or
// backslash in it.
func line(n int) string { return repeated("a long line ñ ♞ 𝄞 ", n) }

// prose is text of at least n bytes with line breaks and comment markup
// in it, and no closing brace.
func prose(n int) string { return repeated("a long comment [%clk 0:01:00] ñ 𝄞\nover lines ", n) }

// longGames are games each holding a token longer than a window: a brace
// comment, a rest-of-line comment, an escape, a tag value, a tag name,
// and a move number whose periods follow a run of spaces (PGN spec
// 8.2.2.1 lets space come between the digits and the periods). The last
// is the one place a gated pattern reads past the window's margin.
func longGames() []string {
	return []string{
		"1. e4 {" + prose(long) + "} e5 *\n\n",
		"1. e4 ;" + line(long) + "\ne5 *\n\n",
		"%" + line(long) + "\n1. e4 e5 *\n\n",
		"[Annotator \"" + line(long) + "\"]\n[" + strings.Repeat("T", long) + " \"x\"]\n\n1. e4 e5 *\n\n",
		"1. e4 e5 2" + strings.Repeat(" ", long) + ". Nf3 Nc6 *\n\n",
	}
}

// longDatabase is filler games with each probe placed so that its token
// starts one byte before a 64 KiB boundary, and so straddles it, followed
// by the games whose tokens are longer than a window.
func longDatabase() string {
	var doc strings.Builder
	n := 0
	for _, probe := range probes {
		next := (doc.Len()/boundary + 1) * boundary
		if next-1-probe.at < doc.Len() {
			next += boundary
		}
		for doc.Len()+len(filler(n))+probe.at+1 < next {
			doc.WriteString(filler(n))
			n++
		}
		doc.WriteString(strings.Repeat("\n", next-1-probe.at-doc.Len()))
		doc.WriteString(probe.game)
	}
	for _, game := range longGames() {
		doc.WriteString(game)
	}
	return doc.String()
}

// straddles holds the long database to what it is for: every probe's
// token straddles a 64 KiB boundary, and every long game's token is
// longer than a window, among the tokens of the whole parse.
func straddles(t *testing.T, text string, spans []readerSpan) {
	t.Helper()
	for _, probe := range probes {
		found := false
		for _, s := range spans {
			if s.name == probe.name && s.si/boundary < (s.si+s.by-1)/boundary {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("no %s straddles a 64 KiB boundary", probe.name)
		}
	}
	for _, name := range []string{"#CMT", "#RMK", "#CM", "#ST", "#TGN", "#MVN"} {
		found := false
		for _, s := range spans {
			if s.name == name && boundary < s.by {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("no %s is longer than a window", name)
		}
	}
	if len(text) < 8*boundary {
		t.Errorf("the long database is only %d bytes", len(text))
	}
}
