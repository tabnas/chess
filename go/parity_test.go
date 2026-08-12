/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// Cross-runtime conformance, driven by the shared `test/spec/*.tsv`
// fixtures at the repo root (see ../test/AGENTS.md).
//
// `ts/test/parity.test.ts` discovers and runs the SAME files, so the two
// implementations cannot drift without one of them going red.

package tabnaschess

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

const specDir = "../test/spec"

type specRow struct {
	line     int
	input    string
	expected string
	opts     string
}

// Decode the escape set used in non-JSON columns. Kept byte-identical to
// the TypeScript loader so both runtimes feed the parser the exact same
// source text.
func unescapeCol(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var out strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if '\\' == c && i+1 < len(s) {
			switch s[i+1] {
			case 'n':
				out.WriteByte('\n')
				i++
				continue
			case 'r':
				out.WriteByte('\r')
				i++
				continue
			case 't':
				out.WriteByte('\t')
				i++
				continue
			case '\\':
				out.WriteByte('\\')
				i++
				continue
			}
		}
		out.WriteByte(c)
	}
	return out.String()
}

func loadSpec(t *testing.T, file string) []specRow {
	t.Helper()
	body, err := os.ReadFile(filepath.Join(specDir, file))
	if nil != err {
		t.Fatalf("cannot read %s: %v", file, err)
	}
	lines := strings.Split(strings.ReplaceAll(string(body), "\r\n", "\n"), "\n")

	rows := []specRow{}
	// Line 1 is the header naming the columns.
	for i := 1; i < len(lines); i++ {
		raw := lines[i]
		// A comment line starts with '#' and has no tab; a data row always
		// has at least one, so a '#'-leading source still works.
		if "" == raw || (strings.HasPrefix(raw, "#") && !strings.Contains(raw, "\t")) {
			continue
		}
		col := strings.Split(raw, "\t")
		if 2 > len(col) {
			t.Fatalf("%s:%d: expected at least 2 tab-separated columns", file, i+1)
		}
		row := specRow{line: i + 1, input: unescapeCol(col[0]), expected: col[1]}
		if 3 <= len(col) {
			row.opts = col[2]
		}
		rows = append(rows, row)
	}
	return rows
}

// A truncated single-line rendering of the input, so a failure names its case.
func label(s string) string {
	one := strings.ReplaceAll(s, "\n", " ; ")
	if 60 < len(one) {
		return one[:57] + "..."
	}
	return one
}

// optionsFromJSON reads the fixture's `opts` column. The column is the
// TypeScript plugin's option object, so the names are the TS ones.
func optionsFromJSON(t *testing.T, raw string) Options {
	t.Helper()
	if "" == strings.TrimSpace(raw) {
		return Options{}
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(raw), &m); nil != err {
		t.Fatalf("bad opts %q: %v", raw, err)
	}
	return optionsFromMap(m)
}

// parseWith runs the configured start rule and returns the result as the
// generic JSON shape the fixture states, so the comparison is against what
// a consumer actually receives.
func parseWith(o Options, src string) (any, error) {
	j := Make(o)
	out, err := j.Parse(src)
	if nil != err {
		return nil, err
	}
	encoded, err := json.Marshal(out)
	if nil != err {
		return nil, err
	}
	var generic any
	if err := json.Unmarshal(encoded, &generic); nil != err {
		return nil, err
	}
	return generic, nil
}

func TestSpec(t *testing.T) {
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
	if 0 == len(files) {
		t.Fatalf("no .tsv fixtures in %s", specDir)
	}

	for _, file := range files {
		t.Run("spec: "+file, func(t *testing.T) {
			rows := loadSpec(t, file)
			if 0 == len(rows) {
				t.Fatalf("%s: no cases", file)
			}
			for _, row := range rows {
				t.Run(label(row.input), func(t *testing.T) {
					o := optionsFromJSON(t, row.opts)
					got, err := parseWith(o, row.input)

					if strings.HasPrefix(row.expected, "ERROR") {
						want := strings.TrimPrefix(
							strings.TrimPrefix(row.expected, "ERROR"), ":")
						if nil == err {
							t.Fatalf("%s:%d: expected %s, got %v",
								file, row.line, row.expected, got)
						}
						if "" != want && !strings.Contains(err.Error(), want) {
							t.Fatalf("%s:%d: expected error containing %q, got %v",
								file, row.line, want, err)
						}
						return
					}

					if nil != err {
						t.Fatalf("%s:%d: %v", file, row.line, err)
					}

					var want any
					if err := json.Unmarshal([]byte(row.expected), &want); nil != err {
						t.Fatalf("%s:%d: bad expected JSON: %v", file, row.line, err)
					}
					if !reflect.DeepEqual(got, want) {
						gotJSON, _ := json.Marshal(got)
						t.Fatalf("%s:%d:\n got: %s\nwant: %s",
							file, row.line, gotJSON, row.expected)
					}
				})
			}
		})
	}
}
