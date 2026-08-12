/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// Cases that a `test/spec/*.tsv` fixture cannot express: option handling,
// error messages, the exported helpers, and the plugin's own surface.
// Mirrors ts/test/chess.test.ts case for case. Everything expressible as
// `input -> JSON` belongs in a fixture instead, where BOTH runtimes run it.

package tabnaschess

import (
	"encoding/json"
	"errors"
	"reflect"
	"regexp"
	"strings"
	"testing"

	tabnas "github.com/tabnas/parser/go"
)

func mustGame(t *testing.T, src string, opts ...Options) *Game {
	t.Helper()
	g, err := ParseGame(src, opts...)
	if nil != err {
		t.Fatalf("ParseGame(%q): %v", src, err)
	}
	if nil == g {
		t.Fatalf("ParseGame(%q): no game", src)
	}
	return g
}

func TestPluginSurface(t *testing.T) {
	t.Run("exports a version", func(t *testing.T) {
		if !regexp.MustCompile(`^\d+\.\d+\.\d+`).MatchString(VERSION) {
			t.Fatalf("VERSION %q is not a semver", VERSION)
		}
	})

	// The plugin sets the error MESSAGES, which are the grammar's business.
	// It must not set `color`, which is the engine's: a caller who installs
	// Chess onto an engine they configured themselves keeps their choice.
	// Make is where the colour gate belongs, because Make builds the engine.
	t.Run("leaves a caller's colour choice alone", func(t *testing.T) {
		on := true
		j := tabnas.Make(tabnas.Options{Color: &tabnas.ColorOptions{Active: &on}})
		if err := Chess(j, nil); nil != err {
			t.Fatal(err)
		}
		if _, err := j.Parse("1. e4 zz"); nil == err {
			t.Fatal("expected a parse error")
		} else if !strings.Contains(err.Error(), "\x1b[") {
			t.Errorf("the plugin overrode the caller's Color option: %q", err.Error())
		}
	})

	t.Run("installs on a bare engine", func(t *testing.T) {
		j := tabnas.Make()
		if err := Chess(j, nil); nil != err {
			t.Fatal(err)
		}
		out, err := j.Parse("e4")
		if nil != err {
			t.Fatal(err)
		}
		db, ok := out.(*Database)
		if !ok || 1 != len(*db) {
			t.Fatalf("unexpected result %#v", out)
		}
		if "e4" != (*db)[0].Moves[0].San {
			t.Fatalf("got %q", (*db)[0].Moves[0].San)
		}
	})

	t.Run("empty source is an empty database", func(t *testing.T) {
		for _, src := range []string{"", "   \n\n  "} {
			db, err := Parse(src)
			if nil != err {
				t.Fatalf("Parse(%q): %v", src, err)
			}
			if 0 != len(db) {
				t.Fatalf("Parse(%q): got %d games", src, len(db))
			}
		}
		g, err := ParseGame("")
		if nil != err || nil != g {
			t.Fatalf("ParseGame(\"\"): %v %v", g, err)
		}
	})
}

func TestStartRule(t *testing.T) {
	t.Run("move start rule returns one move", func(t *testing.T) {
		out, err := Make(Options{Start: "move"}).Parse("Qa6xb7#")
		if nil != err {
			t.Fatal(err)
		}
		got, ok := out.(*Move)
		if !ok {
			t.Fatalf("unexpected result %T", out)
		}
		want := &Move{
			San:            "Qa6xb7#",
			Piece:          "Q",
			Disambiguation: &Disambiguation{File: "a", Rank: 6},
			Capture:        true,
			To:             "b7",
			Check:          "#",
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("got %+v want %+v", got, want)
		}
	})

	t.Run("a bare move has no number or side", func(t *testing.T) {
		out, _ := Make(Options{Start: "move"}).Parse("e4")
		m := out.(*Move)
		if 0 != m.Number || "" != m.Side {
			t.Fatalf("got number=%d side=%q", m.Number, m.Side)
		}
	})

	t.Run("move start rule rejects a move sequence", func(t *testing.T) {
		if _, err := Make(Options{Start: "move"}).Parse("e4 e5"); nil == err {
			t.Fatal("expected an error")
		}
	})
}

func TestSan(t *testing.T) {
	t.Run("ParseSan matches the parser", func(t *testing.T) {
		for _, san := range []string{"e4", "exd5", "Nbd7", "O-O", "e8=Q+", "Qh4e1"} {
			got, ok := ParseSan(san)
			if !ok {
				t.Fatalf("ParseSan(%q) failed", san)
			}
			want := *mustGame(t, san).Moves[0]
			want.Number, want.Side = 0, ""
			if !reflect.DeepEqual(*got, want) {
				t.Fatalf("%s: got %+v want %+v", san, *got, want)
			}
		}
	})

	t.Run("ParseSan rejects a non-move", func(t *testing.T) {
		// A prefix match is not a match: the whole string must be the move.
		for _, src := range []string{"e9", "hello", "", "e4e5"} {
			if m, ok := ParseSan(src); ok {
				t.Fatalf("ParseSan(%q) accepted: %+v", src, m)
			}
		}
	})

	t.Run("a run-together pair of moves is rejected, not split", func(t *testing.T) {
		// Without the symbol-tail check this would silently be e2, e4.
		if _, err := Parse("e2e4"); nil == err {
			t.Fatal("expected an error")
		}
	})

	t.Run("suffix annotation is split off the san", func(t *testing.T) {
		m := mustGame(t, "e4!? *").Moves[0]
		if "e4" != m.San || "!?" != m.Annotation {
			t.Fatalf("got san=%q annotation=%q", m.San, m.Annotation)
		}
	})

	t.Run("AnnotationNag covers every suffix annotation", func(t *testing.T) {
		if 6 != len(AnnotationNag) {
			t.Fatalf("got %d entries", len(AnnotationNag))
		}
		for _, k := range []string{"!", "?", "!!", "??", "!?", "?!"} {
			if _, has := AnnotationNag[k]; !has {
				t.Fatalf("missing %q", k)
			}
		}
	})
}

func TestStrictMode(t *testing.T) {
	importOnly := []struct{ src, why string }{
		{"0-0", "zero castling"},
		{"0-0-0", "zero long castling"},
		{"Pe4", "pawn letter prefix"},
		{"e8Q", "promotion without ="},
		{"e4!", "suffix annotation"},
		{"e4++", "double check"},
	}

	for _, c := range importOnly {
		t.Run("lenient accepts "+c.why, func(t *testing.T) {
			if 1 != len(mustGame(t, c.src+" *").Moves) {
				t.Fatalf("%s not accepted", c.src)
			}
		})
		t.Run("strict rejects "+c.why, func(t *testing.T) {
			if _, err := Parse(c.src+" *", Options{Strict: true}); nil == err {
				t.Fatalf("%s accepted in strict mode", c.src)
			}
		})
	}

	t.Run("both accept canonical san", func(t *testing.T) {
		for _, src := range []string{"e4", "O-O", "O-O-O", "exd5", "e8=Q", "Qa6xb7#", "Nbd7"} {
			if 1 != len(mustGame(t, src+" *").Moves) {
				t.Fatalf("lenient: %s", src)
			}
			if 1 != len(mustGame(t, src+" *", Options{Strict: true}).Moves) {
				t.Fatalf("strict: %s", src)
			}
		}
	})
}

func TestComments(t *testing.T) {
	t.Run("commands are parsed by default and text is kept verbatim", func(t *testing.T) {
		m := mustGame(t, "1. e4 { good [%clk 0:05:00] [%cal Ra1a8,Gb1b8] } *").Moves[0]
		want := []*Comment{{
			Kind: "brace",
			Text: " good [%clk 0:05:00] [%cal Ra1a8,Gb1b8] ",
			Commands: []*Command{
				{Name: "clk", Args: []string{"0:05:00"}},
				{Name: "cal", Args: []string{"Ra1a8", "Gb1b8"}},
			},
		}}
		if !reflect.DeepEqual(m.Comments, want) {
			got, _ := json.Marshal(m.Comments)
			t.Fatalf("got %s", got)
		}
	})

	t.Run("commands can be switched off", func(t *testing.T) {
		g := mustGame(t, "1. e4 {[%clk 0:05:00]} *",
			Options{Commands: false, CommandsSet: true})
		want := []*Comment{{Kind: "brace", Text: "[%clk 0:05:00]"}}
		if !reflect.DeepEqual(g.Moves[0].Comments, want) {
			got, _ := json.Marshal(g.Moves[0].Comments)
			t.Fatalf("got %s", got)
		}
	})

	t.Run("StripCommands removes the markup", func(t *testing.T) {
		if got := StripCommands(" good [%clk 0:05:00] move "); "good move" != got {
			t.Fatalf("got %q", got)
		}
		if got := StripCommands("no markup"); "no markup" != got {
			t.Fatalf("got %q", got)
		}
	})

	t.Run("an unterminated brace comment is an error", func(t *testing.T) {
		_, err := Parse("1. e4 { never closed")
		if nil == err || !strings.Contains(err.Error(), "unterminated") {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("a brace comment may span lines and keeps later positions honest",
		func(t *testing.T) {
			g := mustGame(t, "1. e4 {line one\nline two} e5 *")
			if "line one\nline two" != g.Moves[0].Comments[0].Text {
				t.Fatalf("got %q", g.Moves[0].Comments[0].Text)
			}
			_, err := Parse("1. e4 {line one\nline two}\nzz")
			if nil == err || !strings.Contains(err.Error(), "3:1") {
				t.Fatalf("expected an error at 3:1, got %v", err)
			}
		})
}

func TestEscapeMechanism(t *testing.T) {
	t.Run("a first-column % escapes the line", func(t *testing.T) {
		if 2 != len(mustGame(t, "%private data\n1. e4 e5 *").Moves) {
			t.Fatal("escape line was not ignored")
		}
	})

	t.Run("a % elsewhere is not an escape", func(t *testing.T) {
		if _, err := Parse("1. e4 %private\n"); nil == err {
			t.Fatal("expected an error")
		}
	})
}

func TestTagPairs(t *testing.T) {
	t.Run("a repeated tag name keeps the first value", func(t *testing.T) {
		g := mustGame(t, "[Event \"one\"]\n[Event \"two\"]\n*")
		if "one" != g.Tags["Event"] {
			t.Fatalf("got %q", g.Tags["Event"])
		}
	})

	t.Run("quote and backslash escapes", func(t *testing.T) {
		g := mustGame(t, `[Note "a \"quoted\" \\ word"]`+"\n*")
		if `a "quoted" \ word` != g.Tags["Note"] {
			t.Fatalf("got %q", g.Tags["Note"])
		}
	})

	t.Run("a tag value may be empty", func(t *testing.T) {
		g := mustGame(t, "[Event \"\"]\n*")
		if v, has := g.Tags["Event"]; !has || "" != v {
			t.Fatalf("got %q %v", v, has)
		}
	})

	t.Run("a malformed tag pair is an error", func(t *testing.T) {
		for _, src := range []string{"[Event]\n*", "[Event \"x\"\n*", "[\"x\" Event]\n*"} {
			if _, err := Parse(src); nil == err {
				t.Fatalf("%q was accepted", src)
			}
		}
	})
}

func TestMoveNumbering(t *testing.T) {
	t.Run("numbering is counted when unstated", func(t *testing.T) {
		got := []string{}
		for _, m := range mustGame(t, "e4 e5 Nf3 Nc6 *").Moves {
			dots := "..."
			if "w" == m.Side {
				dots = "."
			}
			got = append(got, strings.TrimSpace(itoa(m.Number)+dots))
		}
		want := []string{"1.", "1...", "2.", "2..."}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("got %v want %v", got, want)
		}
	})

	t.Run("a stated number resynchronises the count", func(t *testing.T) {
		g := mustGame(t, "1. e4 e5 15. Nf3 *")
		if 15 != g.Moves[2].Number {
			t.Fatalf("got %d", g.Moves[2].Number)
		}
	})

	t.Run("three dots mean Black to move", func(t *testing.T) {
		g := mustGame(t, "4... e5 5. Nf3 *")
		if "b" != g.Moves[0].Side || "w" != g.Moves[1].Side {
			t.Fatalf("got %q %q", g.Moves[0].Side, g.Moves[1].Side)
		}
	})

	t.Run("a FEN tag sets the starting number and side", func(t *testing.T) {
		g := mustGame(t,
			"[FEN \"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 12\"]\ne5 Nf3 *")
		if 12 != g.Moves[0].Number || "b" != g.Moves[0].Side {
			t.Fatalf("got %d %q", g.Moves[0].Number, g.Moves[0].Side)
		}
		if 13 != g.Moves[1].Number || "w" != g.Moves[1].Side {
			t.Fatalf("got %d %q", g.Moves[1].Number, g.Moves[1].Side)
		}
	})

	t.Run("a malformed FEN tag falls back to move 1, White", func(t *testing.T) {
		g := mustGame(t, "[FEN \"nonsense\"]\ne4 *")
		if 1 != g.Moves[0].Number || "w" != g.Moves[0].Side {
			t.Fatalf("got %d %q", g.Moves[0].Number, g.Moves[0].Side)
		}
	})

	t.Run("a variation starts on the move it replaces", func(t *testing.T) {
		g := mustGame(t, "1. e4 e5 (1... c5 2. Nf3) 2. Nf3 *")
		v := g.Moves[1].Variations[0]
		if 1 != v.Moves[0].Number || "b" != v.Moves[0].Side {
			t.Fatalf("got %d %q", v.Moves[0].Number, v.Moves[0].Side)
		}
		if 2 != v.Moves[1].Number || "w" != v.Moves[1].Side {
			t.Fatalf("got %d %q", v.Moves[1].Number, v.Moves[1].Side)
		}
	})
}

func TestErrors(t *testing.T) {
	t.Run("an illegal square is rejected", func(t *testing.T) {
		for _, src := range []string{"1. e9 *", "1. Zf3 *"} {
			if _, err := Parse(src); nil == err {
				t.Fatalf("%q was accepted", src)
			}
		}
	})

	t.Run("unbalanced parentheses are rejected", func(t *testing.T) {
		for _, src := range []string{"1. e4 (1. d4 *", "1. e4) *"} {
			if _, err := Parse(src); nil == err {
				t.Fatalf("%q was accepted", src)
			}
		}
	})

	t.Run("the error names the row and column", func(t *testing.T) {
		_, err := Parse("[Event \"x\"]\n\n1. e4 zz")
		if nil == err || !strings.Contains(err.Error(), "3:7") {
			t.Fatalf("expected an error at 3:7, got %v", err)
		}
	})
}

func itoa(n int) string {
	if 0 == n {
		return "0"
	}
	out := ""
	for 0 < n {
		out = string(rune('0'+n%10)) + out
		n /= 10
	}
	return out
}

// The cached parser behind the optionless Parse is read only after
// sync.Once has run. This fails under `go test -race` if that read moves
// back in front of the initializer's write.
func TestParseIsRaceFreeOnFirstUse(t *testing.T) {
	const n = 8
	done := make(chan error, n)
	for i := 0; i < n; i++ {
		go func() {
			db, err := Parse("1. e4 e5 *")
			if nil == err && 1 != len(db) {
				err = errCount
			}
			done <- err
		}()
	}
	for i := 0; i < n; i++ {
		if err := <-done; nil != err {
			t.Fatal(err)
		}
	}
}

var errCount = errors.New("expected exactly one game")
