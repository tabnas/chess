/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// A database is read a game at a time: the database is the only node
// that holds games, and a game joins it only once the game is complete.
// That is what lets a streaming host send a database a game at a time
// (ts/test/stream.test.ts says how), and the ports share the design, so
// this holds the Go port to it too, over every fixture that reads as a
// database and over a database of many games. `rs/tests/stream_test.rs`
// and `ts/test/stream.test.ts` are its twins.
//
// The database is the engine's own list, a *[]any of *Game, so a host
// that empties the engine's lists behind its stream empties it too
// (tabnas/chess#74): the last test empties it as tabnas-transduce's
// ParserEventSource does when it prunes, and holds a long database's
// parse to what it was and its tree flat.

package tabnaschess

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	tabnas "github.com/tabnas/parser/go"
)

type seenNodes struct {
	database *[]any
	others   []string
	joined   []string
}

// watch parses src as a database, watching every rule pass. ok is false
// when the text is not one.
func watch(src string) (seen *seenNodes, games []string, ok bool) {
	seen = &seenNodes{}
	j := Make()
	j.SubRuleDone(func(r *tabnas.Rule, _ *tabnas.Context, _ tabnas.RuleDone) {
		switch node := r.Node.(type) {
		case *[]any:
			if nil == seen.database {
				seen.database = node
			} else if seen.database != node {
				seen.others = append(seen.others, r.Name+" held a database of its own")
				return
			}
			for len(seen.joined) < len(*node) {
				game, _ := json.Marshal((*node)[len(seen.joined)])
				seen.joined = append(seen.joined, string(game))
			}
		case liner:
			seen.others = append(seen.others, r.Name+" held a line of its own")
		}
	})
	value, err := j.Parse(src)
	if nil != err {
		return nil, nil, false
	}
	db, isDatabase := value.(*[]any)
	if !isDatabase {
		return nil, nil, false
	}
	for _, g := range *db {
		game, _ := json.Marshal(g)
		games = append(games, string(game))
	}
	return seen, games, true
}

func assertStreams(t *testing.T, name, src string) bool {
	t.Helper()
	seen, games, ok := watch(src)
	if !ok {
		return false
	}
	if 0 < len(seen.others) {
		t.Fatalf("%s: the database is not the only node holding games: %v", name, seen.others)
	}
	if !reflect.DeepEqual(seen.joined, games) {
		t.Fatalf("%s: a game changed after it joined the database", name)
	}
	return true
}

func TestStreamEveryFixtureDatabase(t *testing.T) {
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
	inputs, read := 0, 0
	for _, file := range files {
		body, err := os.ReadFile(filepath.Join(specDir, file))
		if nil != err {
			t.Fatalf("cannot read %s: %v", file, err)
		}
		lines := strings.Split(strings.ReplaceAll(string(body), "\r\n", "\n"), "\n")
		for i := 1; i < len(lines); i++ {
			raw := lines[i]
			if "" == raw || (strings.HasPrefix(raw, "#") && !strings.Contains(raw, "\t")) {
				continue
			}
			inputs++
			name := fmt.Sprintf("%s:%d", file, i+1)
			if assertStreams(t, name, unescapeCol(strings.Split(raw, "\t")[0])) {
				read++
			}
		}
	}
	// A floor, so that a loader that read nothing cannot pass: 197 of the
	// fixtures' inputs read as databases when this test was written.
	if 150 > read {
		t.Fatalf("only %d of %d inputs read as databases", read, inputs)
	}
}

// manyGames is a database of count games, cycling through every shape a
// game's tree can take while it is built: tags, a FEN start, numbers,
// nags, both kinds of comment with commands, nested variations, a
// variation before the first move, every result, and a game the next
// one's tags end.
func manyGames(count int) string {
	games := []string{
		"[Event \"a\"]\n[Site \"b\"]\n\n1. e4 e5 2. Nf3 {main} Nc6 $1 (2... d6 3. d4 (3. Bc4 $2) exd4) 3. Bb5 1-0",
		"[FEN \"8/8/8/8/8/8/8/8 b - - 0 12\"]\n\n12... e5 13. Nf3 {[%clk 0:01:00]} ; rest of line\n0-1",
		"{before} (1. d4) 1. e4 $14 {after} 1/2-1/2",
		"[Event \"no result\"]\n\n1. c4 c5",
		"[Event \"star\"]\n\n1. a3 *",
	}
	var src strings.Builder
	for round := 0; round < count; round++ {
		src.WriteString(games[round%len(games)])
		src.WriteString("\n\n")
	}
	return src.String()
}

func TestStreamManyGames(t *testing.T) {
	src := manyGames(200)
	if !assertStreams(t, "many", src) {
		t.Fatalf("many: the database does not read")
	}
	seen, _, _ := watch(src)
	if 200 != len(seen.joined) {
		t.Fatalf("many: %d games joined, want 200", len(seen.joined))
	}
}

// emptiedRun is a parse of src with the engine Make builds, its rule
// passes recorded. When empty is set, the database is emptied behind the
// passes as tabnas-transduce's ParserEventSource empties a list when it
// prunes: at each close pass whose rule's node is a *[]any holding
// anything, the list is cleared and truncated in place, and each game it
// held is taken as it stood then. Otherwise the games are the parse's
// value's, after it. most is the most games the database held at a close
// pass.
func emptiedRun(t *testing.T, src string, empty bool) (passes, games []string, most int, value any) {
	t.Helper()
	j := Make()
	j.SubRuleDone(func(r *tabnas.Rule, _ *tabnas.Context, done tabnas.RuleDone) {
		pass := fmt.Sprintf("%s %s", r.Name, done.State)
		if nil != done.Alt {
			pass += fmt.Sprintf(" %v p=%s r=%s b=%d", done.Alt.G, done.Alt.P, done.Alt.R, done.Alt.B)
		}
		passes = append(passes, pass)
		list, ok := r.NodeCell().Node.(*[]any)
		if tabnas.CLOSE != done.State || !ok || nil == list || 0 == len(*list) {
			return
		}
		most = max(most, len(*list))
		if !empty {
			return
		}
		for _, game := range *list {
			encoded, _ := json.Marshal(game)
			games = append(games, string(encoded))
		}
		clear(*list)
		*list = (*list)[:0]
	})
	value, err := j.Parse(src)
	if nil != err {
		t.Fatalf("the parse failed: %v", err)
	}
	if !empty {
		db, err := DatabaseOf(value)
		if nil != err {
			t.Fatal(err)
		}
		for _, game := range db {
			encoded, _ := json.Marshal(game)
			games = append(games, string(encoded))
		}
	}
	return passes, games, most, value
}

// TestAnEmptiedDatabaseParsesOnAndStaysFlat empties the database behind
// the passes, as a host that prunes does, over 200 games and ten times as
// many: the parse makes the same passes and the same games as one that
// empties nothing, the database holds at most the game that just joined,
// and the parse ends with it empty, holding no game even in the array
// behind it. A typed database was out of the emptying's reach, and kept
// every game (tabnas/chess#74).
func TestAnEmptiedDatabaseParsesOnAndStaysFlat(t *testing.T) {
	for _, count := range []int{200, 2000} {
		src := manyGames(count)
		wholePasses, wholeGames, wholeMost, _ := emptiedRun(t, src, false)
		passes, games, most, value := emptiedRun(t, src, true)
		if count != len(wholeGames) || count != wholeMost {
			t.Fatalf("%d games: a parse that empties nothing has %d games, at most %d at a close pass",
				count, len(wholeGames), wholeMost)
		}
		if len(passes) != len(wholePasses) {
			t.Fatalf("%d games: %d passes emptied, %d not", count, len(passes), len(wholePasses))
		}
		for i := range wholePasses {
			if passes[i] != wholePasses[i] {
				t.Fatalf("%d games: pass %d is %q emptied, %q not", count, i, passes[i], wholePasses[i])
			}
		}
		if !reflect.DeepEqual(games, wholeGames) {
			t.Fatalf("%d games: the games emptied out of the database are not the parse's", count)
		}
		if 1 != most {
			t.Fatalf("%d games: the emptied database held %d games at a close pass, not 1", count, most)
		}
		list, ok := value.(*[]any)
		if !ok || nil == list {
			t.Fatalf("%d games: the parse returned %T, not the database", count, value)
		}
		if 0 != len(*list) {
			t.Fatalf("%d games: the emptied database ends holding %d games", count, len(*list))
		}
		for _, item := range (*list)[:cap(*list)] {
			if nil != item {
				t.Fatalf("%d games: the array behind the emptied database still holds a %T", count, item)
			}
		}
		t.Logf("%d games: %d passes, the emptied database held at most %d game, and none at the end",
			count, len(passes), most)
	}
}
