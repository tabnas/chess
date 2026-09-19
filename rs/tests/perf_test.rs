/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

//! Performance regression guard. Mirrors `ts/test/perf.test.ts` and
//! `go/perf_test.go`.
//!
//! `make` builds an engine and a grammar; the optionless `parse` caches
//! one. This guards the usage the docs recommend for bulk work — build
//! ONE instance and reuse it — and would fail if a future change made a
//! reused parse rebuild the grammar anyway.
//!
//! The check is machine-INDEPENDENT: it compares reuse against a single
//! parse and against the rebuild-per-parse anti-pattern on the SAME
//! machine in the SAME run, so a slow CI box cannot make it flaky. There
//! is deliberately NO absolute wall-clock budget.

use std::time::Instant;

use tabnas_chess::{make, model_of, Database};

/// A representative annotated game: tag pairs, comments, a glyph, a
/// variation and a termination marker.
const PERF_SRC: &str = concat!(
    "[Event \"x\"]\n[Result \"1-0\"]\n\n",
    "1. e4 e5 2. Nf3 {solid} Nc6 $1 (2... d6 3. d4 exd4) 3. Bb5 a6 4. Ba4 Nf6 1-0"
);

/// Smaller than the 1000 TypeScript and Go use: `cargo test` runs the
/// unoptimised profile, where 1000 of these cost ten seconds against the
/// rest of this crate's suite at three. The guard is a ratio measured on
/// one machine in one run, so the count only has to be large enough to
/// average out scheduler noise.
const PERF_N: u32 = 300;

#[test]
fn parse_reuses_instance() {
    let tn = make(&Default::default()).expect("the grammar installs");

    // Warm the reuse path, and sanity-check the parse result en route.
    for _ in 0..100 {
        let games: Database =
            model_of(&tn.parse(PERF_SRC).expect("it parses")).expect("a database");
        assert_eq!(1, games.len());
        assert_eq!(Some(tabnas_chess::GameResult::White), games[0].result);
        assert_eq!(8, games[0].line.moves.len());
        assert_eq!(3, games[0].line.moves[3].variations[0].moves.len());
    }

    // One isolated (already-warmed) parse on the reused instance.
    let start = Instant::now();
    tn.parse(PERF_SRC).expect("it parses");
    let single = start.elapsed();

    // N parses reusing the ONE instance.
    let start = Instant::now();
    for _ in 0..PERF_N {
        tn.parse(PERF_SRC).expect("it parses");
    }
    let reuse = start.elapsed();

    // N parses that REBUILD a fresh instance every call — the
    // anti-pattern this guards against.
    let start = Instant::now();
    for _ in 0..PERF_N {
        make(&Default::default())
            .expect("the grammar installs")
            .parse(PERF_SRC)
            .expect("it parses");
    }
    let rebuild = start.elapsed();

    let average = reuse / PERF_N;

    // 1) Reuse must stay (near) linear: amortized per-parse time over N
    //    reused parses should be within a small factor of a single warmed
    //    parse. Allow 4x for scheduling / timer noise.
    assert!(
        single.is_zero() || average <= 4 * single,
        "reuse is not staying linear: {PERF_N} reused parses took {reuse:?} \
         (avg {average:?}/parse) vs {single:?} for a single parse (limit 4x)"
    );

    // 2) Reuse must be materially faster than rebuilding per parse. The
    //    floor is 2x, as in Go: on this engine a grammar build costs a
    //    few parses of this size rather than the ~17x it costs in Node,
    //    so a higher bar would sit close enough to the real ratio to go
    //    flaky on a loaded box. 2x still fails loudly if representative
    //    usage ever starts rebuilding per parse.
    assert!(
        rebuild >= 2 * reuse,
        "rebuild-per-parse is not dominated by reuse as expected: \
         rebuild={rebuild:?} reuse={reuse:?} (expected >2x). Building the \
         grammar should dominate — reuse a single instance."
    );

    println!(
        "[perf] single={single:?} reuse(N={PERF_N})={reuse:?} avg={average:?} \
         rebuild(N={PERF_N})={rebuild:?} rebuild/reuse={:.1}x",
        rebuild.as_secs_f64() / reuse.as_secs_f64()
    );
}
