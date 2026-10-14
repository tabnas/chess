/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// A database is read a game at a time: the database is the only node
// that holds games, and a game joins it only once the game is complete.
// That is what lets a streaming host send a database a game at a time
// (ts/test/stream.test.ts says how), and the ports share the design, so
// this holds the Go port to it too, over every fixture that reads as a
// database and over a database of many games. `rs/tests/stream_test.rs`
// and `ts/test/stream.test.ts` are its twins.

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
	database *Database
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
		case *Database:
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
	db, isDatabase := value.(*Database)
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

func TestStreamManyGames(t *testing.T) {
	// Every shape a game's tree can take while it is built: tags, a FEN
	// start, numbers, nags, both kinds of comment with commands, nested
	// variations, a variation before the first move, every result, and a
	// game the next one's tags end.
	games := []string{
		"[Event \"a\"]\n[Site \"b\"]\n\n1. e4 e5 2. Nf3 {main} Nc6 $1 (2... d6 3. d4 (3. Bc4 $2) exd4) 3. Bb5 1-0",
		"[FEN \"8/8/8/8/8/8/8/8 b - - 0 12\"]\n\n12... e5 13. Nf3 {[%clk 0:01:00]} ; rest of line\n0-1",
		"{before} (1. d4) 1. e4 $14 {after} 1/2-1/2",
		"[Event \"no result\"]\n\n1. c4 c5",
		"[Event \"star\"]\n\n1. a3 *",
	}
	var src strings.Builder
	for round := 0; round < 200; round++ {
		src.WriteString(games[round%len(games)])
		src.WriteString("\n\n")
	}
	if !assertStreams(t, "many", src.String()) {
		t.Fatalf("many: the database does not read")
	}
	seen, _, _ := watch(src.String())
	if 200 != len(seen.joined) {
		t.Fatalf("many: %d games joined, want 200", len(seen.joined))
	}
}
