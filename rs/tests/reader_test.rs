/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

//! A parse from a reader (`Tabnas::parse_reader`, admin ADR-30).
//! [`make`] declares `lex.window`, so a database is read a window of the
//! source at a time, and the plugin's matchers read the text only through
//! the window, each filling it as far as it reads (`src/lex.rs`). Every
//! row of the shared fixtures parses the same from a reader as from its
//! text, handed over in pieces of 1, 3 and 64 bytes, under the fixed
//! window and under windows of a few characters, so that every matcher
//! meets the window's edge: the same value, tokens and rule passes, and
//! an error's code, position, row and column. So does a long database
//! whose tokens of every kind straddle the 64 KiB boundaries, its
//! comments, remarks, escapes, tag values, tag names and move numbers
//! longer than a window included. `ts/test/reader.test.ts` and
//! `go/reader_test.go` are its twins.

use std::fs;
use std::io::Read;
use std::sync::{Arc, Mutex};

use tabnas::{RuleState, Tabnas, TabnasError, Value, WindowSizes};
use tabnas_chess::{chess, make, to_json, ChessOptions};

const SPEC_DIR: &str = "../test/spec";

/// A reader that hands its bytes over at most `size` at a time.
struct Pieces<'a> {
    bytes: &'a [u8],
    at: usize,
    size: usize,
}

impl<'a> Pieces<'a> {
    fn new(bytes: &'a [u8], size: usize) -> Self {
        Pieces { bytes, at: 0, size }
    }
}

impl Read for Pieces<'_> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.size.min(buf.len()).min(self.bytes.len() - self.at);
        buf[..n].copy_from_slice(&self.bytes[self.at..self.at + n]);
        self.at += n;
        Ok(n)
    }
}

/// Decode the escape set of a fixture column, as `parity_test.rs` does.
fn unescape_col(column: &str) -> String {
    let mut out = String::with_capacity(column.len());
    let mut characters = column.chars().peekable();
    while let Some(character) = characters.next() {
        if '\\' == character {
            let decoded = match characters.peek() {
                Some('n') => Some('\n'),
                Some('r') => Some('\r'),
                Some('t') => Some('\t'),
                Some('\\') => Some('\\'),
                _ => None,
            };
            if let Some(decoded) = decoded {
                out.push(decoded);
                characters.next();
                continue;
            }
        }
        out.push(character);
    }
    out
}

/// Every fixture row: where it is, its input and its options.
fn rows() -> Vec<(String, String, ChessOptions)> {
    let mut files: Vec<_> = fs::read_dir(SPEC_DIR)
        .expect("the shared fixtures, beside rs/")
        .map(|entry| entry.expect("a directory entry").path())
        .filter(|path| path.extension().is_some_and(|extension| "tsv" == extension))
        .collect();
    files.sort();
    let mut rows = Vec::new();
    for file in files {
        let name = file
            .file_name()
            .expect("a file name")
            .to_string_lossy()
            .to_string();
        let body = fs::read_to_string(&file).expect("a readable fixture");
        for (index, raw) in body.replace("\r\n", "\n").split('\n').enumerate().skip(1) {
            if raw.is_empty() || (raw.starts_with('#') && !raw.contains('\t')) {
                continue;
            }
            let column: Vec<&str> = raw.split('\t').collect();
            let opts = column.get(2).copied().unwrap_or("");
            let options = if opts.trim().is_empty() {
                ChessOptions::default()
            } else {
                serde_json::from_str(opts).expect("a fixture's options")
            };
            rows.push((
                format!("{name}:{}", index + 1),
                unescape_col(column[0]),
                options,
            ));
        }
    }
    rows
}

/// What a parse records as it goes: the tokens the lexer gives, ignored
/// ones included, and the rule passes, and each token's name, position
/// and length in characters.
#[derive(Default)]
struct Log {
    tokens: Vec<String>,
    rules: Vec<String>,
    spans: Vec<(String, usize, usize)>,
}

type Shared = Arc<Mutex<Log>>;

/// `parser`, recording the tokens and rule passes of each parse into `log`.
fn recorded(mut parser: Tabnas, log: &Shared) -> Tabnas {
    let tokens = Arc::clone(log);
    parser.subscribe_lex(move |token, _rule, _context| {
        let mut log = tokens.lock().unwrap();
        log.tokens.push(format!(
            "{} {:?} {} {} {}:{}",
            token.name.as_str(),
            token.src.as_str(),
            to_json(&token.val),
            token.site.pos,
            token.site.ri,
            token.site.ci
        ));
        log.spans.push((
            token.name.as_str().to_string(),
            token.site.pos,
            token.src.as_str().chars().count(),
        ));
    });
    let rules = Arc::clone(log);
    parser.subscribe_rule_done(move |rule, _context, done| {
        let state = match done.state {
            RuleState::Open => "open",
            RuleState::Close => "close",
        };
        rules
            .lock()
            .unwrap()
            .rules
            .push(format!("{} {state}", rule.name.as_str()));
    });
    parser
}

/// What a parse showed: its value, or its error's code, position, row,
/// column and token (not its excerpt, which a window may cut); and what
/// `log` recorded, which is empty again after.
#[derive(Debug, PartialEq)]
struct Seen {
    outcome: String,
    tokens: Vec<String>,
    rules: Vec<String>,
}

fn seen(log: &Shared, parsed: Result<Value, TabnasError>) -> (Seen, Vec<(String, usize, usize)>) {
    let outcome = match parsed {
        Ok(value) => format!("ok {}", to_json(&value)),
        Err(e) => format!(
            "err {} at {} {}:{} {:?} {:?}",
            e.code, e.pos, e.row, e.col, e.src, e.token
        ),
    };
    let log = std::mem::take(&mut *log.lock().unwrap());
    (
        Seen {
            outcome,
            tokens: log.tokens,
            rules: log.rules,
        },
        log.spans,
    )
}

/// Windows whose margin and block are a few characters, so that every
/// matcher meets the window's edge, and the fixed window (`None`).
const WINDOWS: [Option<(usize, usize)>; 4] = [None, Some((1, 1)), Some((3, 2)), Some((64, 64))];

/// What a parse of `bytes` from a reader showed, handed over in pieces of
/// `size` under `window`.
fn from_reader(
    log: &Shared,
    parser: &Tabnas,
    bytes: &[u8],
    size: usize,
    window: Option<(usize, usize)>,
) -> Seen {
    let parsed = match window {
        None => parser.parse_reader(Pieces::new(bytes, size)),
        Some((margin, block)) => parser.parse_reader_with_sizes(
            Pieces::new(bytes, size),
            WindowSizes {
                margin,
                block,
                chunk: size,
            },
        ),
    };
    seen(log, parsed).0
}

#[test]
fn make_declares_the_window_and_the_plugin_leaves_it_to_its_caller() {
    let options = ChessOptions::default();
    assert!(
        make(&options)
            .expect("the grammar installs")
            .options
            .lex
            .window
    );
    let strict = ChessOptions {
        strict: true,
        start: tabnas_chess::Start::Move,
        ..ChessOptions::default()
    };
    assert!(
        make(&strict)
            .expect("the grammar installs")
            .options
            .lex
            .window
    );
    let mut tn = Tabnas::new();
    chess(&mut tn, &options).expect("the grammar installs");
    assert!(!tn.options.lex.window);
}

#[test]
fn every_fixture_row_parses_the_same_from_a_reader() {
    let rows = rows();
    let mut compared = 0;
    for (index, (at, input, options)) in rows.iter().enumerate() {
        let log = Shared::default();
        let parser = recorded(make(options).expect("the grammar installs"), &log);
        let (whole, _) = seen(&log, parser.parse(input));
        for size in [1, 3, 64] {
            for window in WINDOWS {
                let read = from_reader(&log, &parser, input.as_bytes(), size, window);
                assert_eq!(read, whole, "{at} in pieces of {size}, window {window:?}");
                compared += 1;
            }
        }
        if 0 == (index + 1) % 100 || index + 1 == rows.len() {
            println!(
                "reader differential: {} of {} rows ({}%), {compared} reader parses",
                index + 1,
                rows.len(),
                (index + 1) * 100 / rows.len()
            );
        }
    }
    assert!(3000 < compared, "{compared}");
}

#[test]
fn a_long_database_parses_the_same_from_a_reader() {
    let text = long_database();
    let log = Shared::default();
    let parser = recorded(
        make(&ChessOptions::default()).expect("the grammar installs"),
        &log,
    );
    let (whole, spans) = seen(&log, parser.parse(&text));
    assert!(
        whole.outcome.starts_with("ok "),
        "{}",
        &whole.outcome[..200.min(whole.outcome.len())]
    );
    straddles(&text, &spans);

    for (size, window) in [(4096, None), (65536, None), (7, Some((16, 16)))] {
        let read = from_reader(&log, &parser, text.as_bytes(), size, window);
        assert_eq!(
            read.outcome, whole.outcome,
            "in pieces of {size}, window {window:?}"
        );
        assert_eq!(
            read.tokens.len(),
            whole.tokens.len(),
            "in pieces of {size}, window {window:?}"
        );
        assert!(
            read.tokens == whole.tokens,
            "the tokens differ: in pieces of {size}, window {window:?}"
        );
        assert!(
            read.rules == whole.rules,
            "the rule passes differ: in pieces of {size}, window {window:?}"
        );
    }
}

#[test]
fn a_comment_left_open_at_the_end_fails_where_its_text_does() {
    let text = format!("{}1. e4 {{never closed {}", long_database(), line(LONG));
    let log = Shared::default();
    let parser = make(&ChessOptions::default()).expect("the grammar installs");
    let (whole, _) = seen(&log, parser.parse(&text));
    assert!(
        whole.outcome.starts_with("err unterminated_comment at "),
        "{}",
        &whole.outcome[..80.min(whole.outcome.len())]
    );
    for size in [4096, 65536] {
        let read = from_reader(&log, &parser, text.as_bytes(), size, None);
        assert_eq!(read.outcome, whole.outcome, "in pieces of {size}");
    }
}

// --- A long database ----------------------------------------------------

/// The window's fixed margin and block, in characters.
const BOUNDARY: usize = 64 * 1024;

/// Longer than a window.
const LONG: usize = 70_000;

/// A game of the kind a database is mostly made of: tag pairs, comments
/// with markup, a glyph, a variation, a rest-of-line comment, an escape
/// and a termination marker, with characters past ASCII among them.
fn filler(i: usize) -> String {
    format!(
        "[Event \"Filler {i} ñ\"]\n[Site \"Göteborg ♞\"]\n[Round \"{i}\"]\n[Result \"1-0\"]\n\n\
         1. e4 e5 2. Nf3 {{[%clk 0:03:00] the main line 𝄞}} Nc6 $1 (2... d6 3. d4 exd4) \
         3. Bb5 a6 ; a remark é\n% private data\n4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 \
         7. Bb3 d6 8. c3 O-O 9. h3 Na5 10. Bc2 c5 11. d4 Qc7 12. Nbd2 cxd4 1-0\n\n"
    )
}

/// Games that each hold a token of one kind at a known place in their
/// text: the token's name, the game, and where the token starts in it.
const PROBES: [(&str, &str, usize); 11] = [
    ("#TGN", "[WhiteElo \"2700\"]\n\n1. d4 d5 1-0\n\n", 1),
    ("#ST", "[Event \"Probe ñ\"]\n\n1. d4 d5 1-0\n\n", 7),
    ("#MVN", "12... Nf6 13. Nbd2 *\n\n", 0),
    ("#SAN", "1. Nbxd2+ e5 *\n\n", 3),
    ("#NAG", "1. e4 $123 e5 *\n\n", 6),
    ("#RES", "1. e4 e5 1/2-1/2\n\n", 9),
    ("#CMT", "1. e4 {a comment ñ\nover two lines} e5 *\n\n", 6),
    ("#RMK", "1. e4 ; a remark ñ\ne5 *\n\n", 6),
    ("#CM", "% an escape line\n1. e4 e5 *\n\n", 0),
    ("#SP", "1. e4      e5 *\n\n", 5),
    ("#LN", "1. e4\r\ne5 *\r\n\r\n", 5),
];

/// At least `n` characters of whole copies of `unit`.
fn repeated(unit: &str, n: usize) -> String {
    unit.repeat(n.div_ceil(unit.chars().count()))
}

/// Text of at least `n` characters with no line break, quote or backslash
/// in it.
fn line(n: usize) -> String {
    repeated("a long line ñ ♞ 𝄞 ", n)
}

/// Text of at least `n` characters with line breaks and comment markup in
/// it, and no closing brace.
fn prose(n: usize) -> String {
    repeated("a long comment [%clk 0:01:00] ñ 𝄞\nover lines ", n)
}

/// Games each holding a token longer than a window: a brace comment, a
/// rest-of-line comment, an escape, a tag value, a tag name, and a move
/// number whose periods follow a run of spaces (PGN spec 8.2.2.1 lets
/// space come between the digits and the periods). The last is the one
/// place a gated pattern reads past the window's margin.
fn long_games() -> Vec<String> {
    vec![
        format!("1. e4 {{{}}} e5 *\n\n", prose(LONG)),
        format!("1. e4 ;{}\ne5 *\n\n", line(LONG)),
        format!("%{}\n1. e4 e5 *\n\n", line(LONG)),
        format!(
            "[Annotator \"{}\"]\n[{} \"x\"]\n\n1. e4 e5 *\n\n",
            line(LONG),
            "T".repeat(LONG)
        ),
        format!("1. e4 e5 2{}. Nf3 Nc6 *\n\n", " ".repeat(LONG)),
    ]
}

/// Filler games with each probe placed so that its token starts one
/// character before a 64 KiB boundary, and so straddles it, followed by
/// the games whose tokens are longer than a window.
fn long_database() -> String {
    let mut doc = String::new();
    let mut length = 0;
    let mut n = 0;
    for (_, game, at) in PROBES {
        let mut next = (length / BOUNDARY + 1) * BOUNDARY;
        if next - 1 - at < length {
            next += BOUNDARY;
        }
        loop {
            let game = filler(n);
            let count = game.chars().count();
            if next <= length + count + at + 1 {
                break;
            }
            doc.push_str(&game);
            length += count;
            n += 1;
        }
        let pad = next - 1 - at - length;
        doc.push_str(&"\n".repeat(pad));
        doc.push_str(game);
        length += pad + game.chars().count();
    }
    for game in long_games() {
        doc.push_str(&game);
    }
    doc
}

/// Every probe's token straddles a 64 KiB boundary, and every long game's
/// token is longer than a window, among the tokens of the whole parse.
fn straddles(text: &str, spans: &[(String, usize, usize)]) {
    for (name, _, _) in PROBES {
        assert!(
            spans.iter().any(|(kind, pos, len)| kind == name
                && pos / BOUNDARY < (pos + len - 1) / BOUNDARY),
            "no {name} straddles a 64 KiB boundary"
        );
    }
    for name in ["#CMT", "#RMK", "#CM", "#ST", "#TGN", "#MVN"] {
        assert!(
            spans
                .iter()
                .any(|(kind, _, len)| kind == name && BOUNDARY < *len),
            "no {name} is longer than a window"
        );
    }
    assert!(8 * BOUNDARY < text.chars().count(), "{}", text.len());
}
