/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// Performance regression guard. Mirrors ts/test/perf.test.ts.
//
// Make() builds an engine and a grammar; Parse() without options caches
// one. This guards the usage the docs recommend for bulk work — build ONE
// instance and reuse it — and would fail if a future change made a reused
// parse rebuild the grammar anyway.
//
// The check is machine-INDEPENDENT: it compares reuse against a single
// parse and against the rebuild-per-parse anti-pattern on the SAME machine
// in the SAME run, so a slow CI box cannot make it flaky. There is
// deliberately NO absolute wall-clock budget.

package tabnaschess

import (
	"testing"
	"time"
)

// A representative annotated game: tag pairs, comments, a glyph, a
// variation and a termination marker.
const perfSrc = "[Event \"x\"]\n[Result \"1-0\"]\n\n" +
	"1. e4 e5 2. Nf3 {solid} Nc6 $1 (2... d6 3. d4 exd4) 3. Bb5 a6 4. Ba4 Nf6 1-0"

const perfN = 1000

func TestParseReusesInstance(t *testing.T) {
	j := Make()

	// Warm the reuse path, and sanity-check the parse result en route.
	for i := 0; i < 100; i++ {
		out, err := j.Parse(perfSrc)
		if nil != err {
			t.Fatal(err)
		}
		db := *(out.(*Database))
		if 1 != len(db) || "1-0" != db[0].Result {
			t.Fatalf("unexpected result %+v", db)
		}
		if 8 != len(db[0].Moves) {
			t.Fatalf("got %d moves", len(db[0].Moves))
		}
		if 3 != len(db[0].Moves[3].Variations[0].Moves) {
			t.Fatalf("got %d variation moves", len(db[0].Moves[3].Variations[0].Moves))
		}
	}

	// One isolated (already-warmed) parse on the reused instance.
	start := time.Now()
	if _, err := j.Parse(perfSrc); nil != err {
		t.Fatal(err)
	}
	single := time.Since(start)

	// N parses reusing the ONE instance.
	start = time.Now()
	for i := 0; i < perfN; i++ {
		if _, err := j.Parse(perfSrc); nil != err {
			t.Fatal(err)
		}
	}
	reuse := time.Since(start)

	// N parses that REBUILD a fresh instance every call — the
	// anti-pattern this guards against.
	start = time.Now()
	for i := 0; i < perfN; i++ {
		if _, err := Make().Parse(perfSrc); nil != err {
			t.Fatal(err)
		}
	}
	rebuild := time.Since(start)

	avgReuse := reuse / perfN

	// 1) Reuse must stay (near) linear: amortized per-parse time over N
	//    reused parses should be within a small factor of a single warmed
	//    parse. Allow 4x for scheduling / timer noise.
	if 0 < single && avgReuse > 4*single {
		t.Fatalf("reuse is not staying linear: %d reused parses took %v "+
			"(avg %v/parse) vs %v for a single parse (limit 4x)",
			perfN, reuse, avgReuse, single)
	}

	// 2) Reuse must be materially faster than rebuilding per parse.
	//    The floor is 2x here where the TypeScript guard uses 4x: on this
	//    engine a grammar build costs roughly 4x a parse of this size, not
	//    the ~17x it costs in Node, so 4x would sit close enough to the
	//    real ratio to go flaky on a loaded box. 2x still fails loudly if
	//    representative usage ever starts rebuilding per parse.
	if rebuild < 2*reuse {
		t.Fatalf("rebuild-per-parse is not dominated by reuse as expected: "+
			"rebuild=%v reuse=%v (expected >2x). Building the grammar should "+
			"dominate — reuse a single instance.", rebuild, reuse)
	}

	t.Logf("[perf] single=%v reuse(N=%d)=%v avg=%v rebuild(N=%d)=%v rebuild/reuse=%.1fx",
		single, perfN, reuse, avgReuse, perfN, rebuild,
		float64(rebuild)/float64(reuse))
}
