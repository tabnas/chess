/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

//! Cross-runtime conformance, driven by the shared `test/spec/*.tsv`
//! fixtures at the repo root (see ../../test/AGENTS.md).
//!
//! `ts/test/parity.test.ts` and `go/parity_test.go` discover and run the
//! SAME files, so no two of the three implementations can drift without
//! one of them going red.

use std::fs;
use std::path::{Path, PathBuf};

use tabnas::Tabnas;
use tabnas_chess::{chess, to_json, ChessOptions};

const SPEC_DIR: &str = "../test/spec";

struct SpecRow {
    line: usize,
    input: String,
    expected: String,
    opts: String,
}

/// Decode the escape set used in non-JSON columns. Kept byte-identical to
/// the TypeScript and Go loaders so all three runtimes feed the parser the
/// exact same source text.
fn unescape_col(column: &str) -> String {
    if !column.contains('\\') {
        return column.to_string();
    }
    let mut out = String::with_capacity(column.len());
    let bytes = column.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        if b'\\' == bytes[at] && at + 1 < bytes.len() {
            let decoded = match bytes[at + 1] {
                b'n' => Some('\n'),
                b'r' => Some('\r'),
                b't' => Some('\t'),
                b'\\' => Some('\\'),
                _ => None,
            };
            if let Some(decoded) = decoded {
                out.push(decoded);
                at += 2;
                continue;
            }
        }
        // `column` is UTF-8 and every byte matched above is ASCII, so the
        // remainder is copied a character at a time rather than a byte.
        let character = column[at..].chars().next().expect("index is a boundary");
        out.push(character);
        at += character.len_utf8();
    }
    out
}

fn load_spec(file: &Path) -> Vec<SpecRow> {
    let body = fs::read_to_string(file)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", file.display()));
    let body = body.replace("\r\n", "\n");

    let mut rows = Vec::new();
    // Line 1 is the header naming the columns.
    for (index, raw) in body.split('\n').enumerate().skip(1) {
        // A comment line starts with '#' and has no tab; a data row always
        // has at least one, so a '#'-leading source still works.
        if raw.is_empty() || (raw.starts_with('#') && !raw.contains('\t')) {
            continue;
        }
        let column: Vec<&str> = raw.split('\t').collect();
        assert!(
            2 <= column.len(),
            "{}:{}: expected at least 2 tab-separated columns",
            file.display(),
            index + 1
        );
        rows.push(SpecRow {
            line: index + 1,
            input: unescape_col(column[0]),
            expected: column[1].to_string(),
            opts: column.get(2).unwrap_or(&"").to_string(),
        });
    }
    rows
}

/// A truncated single-line rendering of the input, so a failure names its
/// case.
fn label(input: &str) -> String {
    let one = input.replace('\n', " ; ");
    if 60 < one.chars().count() {
        let head: String = one.chars().take(57).collect();
        return format!("{head}...");
    }
    one
}

/// Read the fixture's `opts` column. The column is the TypeScript
/// plugin's option object, so the names are the TS ones.
fn options_from_json(raw: &str) -> ChessOptions {
    if raw.trim().is_empty() {
        return ChessOptions::default();
    }
    serde_json::from_str(raw).unwrap_or_else(|error| panic!("bad opts {raw:?}: {error}"))
}

/// Run the configured start rule and return the result as the generic
/// JSON shape the fixture states, so the comparison is against what a
/// consumer actually receives.
fn parse_with(options: &ChessOptions, src: &str) -> Result<serde_json::Value, String> {
    let mut tn = Tabnas::new();
    // Fixed, rather than left to `make`: a fixture compares text, and an
    // escape code from an incidental terminal would change it.
    tn.options.color.active = false;
    chess(&mut tn, options).expect("the chess grammar installs");
    tn.parse(src)
        .map(|value| to_json(&value))
        .map_err(|error| error.to_string())
}

fn spec_files() -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = fs::read_dir(SPEC_DIR)
        .unwrap_or_else(|error| panic!("cannot read {SPEC_DIR}: {error}"))
        .map(|entry| entry.expect("a readable directory entry").path())
        .filter(|path| Some("tsv") == path.extension().and_then(|kind| kind.to_str()))
        .collect();
    files.sort();
    assert!(!files.is_empty(), "no .tsv fixtures in {SPEC_DIR}");
    files
}

#[test]
fn spec() {
    let mut failures: Vec<String> = Vec::new();
    let mut cases = 0;

    for file in spec_files() {
        let name = file
            .file_name()
            .expect("a file")
            .to_string_lossy()
            .to_string();
        let rows = load_spec(&file);
        assert!(!rows.is_empty(), "{name}: no cases");

        for row in rows {
            cases += 1;
            let options = options_from_json(&row.opts);
            let at = format!("{name}:{} [{}]", row.line, label(&row.input));
            let got = parse_with(&options, &row.input);

            if let Some(want) = row.expected.strip_prefix("ERROR") {
                let want = want.strip_prefix(':').unwrap_or(want);
                match got {
                    Ok(value) => {
                        failures.push(format!("{at}: expected {}, got {value}", row.expected))
                    }
                    Err(error) if !want.is_empty() && !error.contains(want) => failures.push(
                        format!("{at}: expected error containing {want:?}, got {error}"),
                    ),
                    Err(_) => {}
                }
                continue;
            }

            let want: serde_json::Value = serde_json::from_str(&row.expected)
                .unwrap_or_else(|error| panic!("{at}: bad expected JSON: {error}"));
            match got {
                Err(error) => failures.push(format!("{at}: {error}")),
                Ok(value) if value != want => {
                    failures.push(format!("{at}:\n got: {value}\nwant: {want}"))
                }
                Ok(_) => {}
            }
        }
    }

    println!("ran {cases} spec cases across the shared fixtures");
    assert!(
        failures.is_empty(),
        "{} of {cases} spec cases failed:\n\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}
