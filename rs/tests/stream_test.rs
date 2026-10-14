/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

//! A database is read a game at a time.
//!
//! A streaming host follows a parse through its rule nodes:
//! tabnas-transduce's rule-event adapter streams a container that is a
//! rule's node as the rules close, and walks one that arrives complete.
//! So a database streams a game at a time exactly when it is the only
//! container any rule holds, and a game joins it only once the game is
//! complete. These tests hold the plugin to both, over every fixture
//! that reads as a database and over a database of many games, without
//! depending on the adapter.

use std::fs;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{Arc, Mutex};

use tabnas::Value;
use tabnas_chess::{make, ChessOptions};

#[derive(Default)]
struct Seen {
    /// The cell of the first container a rule held: the database's.
    database: Option<usize>,
    /// A rule that held any other container.
    others: Vec<String>,
    /// Each game as it was when it joined the database.
    joined: Vec<serde_json::Value>,
}

fn container(value: &Value) -> bool {
    matches!(
        value,
        Value::Array(_) | Value::Object(_) | Value::ListRef(_) | Value::MapRef(_)
    )
}

/// Parse `src` as a database, watching every rule pass. `None` when the
/// text is not one.
fn watch(src: &str) -> Option<(Seen, serde_json::Value)> {
    let seen = Arc::new(Mutex::new(Seen::default()));
    let mut tn = make(&ChessOptions::default()).expect("the grammar installs");
    let watcher = seen.clone();
    tn.subscribe_rule_done(move |rule, _context, _done| {
        let node = rule.node.borrow();
        if !container(&node) {
            return;
        }
        let cell = Rc::as_ptr(&rule.node) as usize;
        let mut seen = watcher.lock().expect("one parse, one thread");
        match seen.database {
            None => seen.database = Some(cell),
            Some(database) if database == cell => {
                let Value::Array(games) = &*node else {
                    seen.others
                        .push(format!("{:?} made the database no list", rule.name));
                    return;
                };
                while seen.joined.len() < games.len() {
                    let game = games[seen.joined.len()].to_json();
                    seen.joined.push(game);
                }
            }
            Some(_) => {
                let others = format!("{:?} held a container of its own", rule.name);
                seen.others.push(others);
            }
        }
    });
    let value = tn.parse(src).ok()?;
    let seen = std::mem::take(&mut *seen.lock().expect("one parse, one thread"));
    Some((seen, value.to_json()))
}

fn assert_streams(name: &str, src: &str) -> bool {
    let Some((seen, value)) = watch(src) else {
        return false;
    };
    assert!(
        seen.others.is_empty(),
        "{name}: the database is not the only container: {:?}",
        seen.others
    );
    let games = value.as_array().expect("a database is a list of games");
    assert_eq!(
        &seen.joined, games,
        "{name}: a game changed after it joined the database"
    );
    true
}

/// Decode the escape set of a fixture column, as `parity_test.rs` does.
fn unescape_col(column: &str) -> String {
    let mut out = String::with_capacity(column.len());
    let mut chars = column.chars().peekable();
    while let Some(character) = chars.next() {
        if '\\' == character {
            let decoded = match chars.peek() {
                Some('n') => Some('\n'),
                Some('r') => Some('\r'),
                Some('t') => Some('\t'),
                Some('\\') => Some('\\'),
                _ => None,
            };
            if let Some(decoded) = decoded {
                out.push(decoded);
                chars.next();
                continue;
            }
        }
        out.push(character);
    }
    out
}

/// The input column of every row of `test/spec/*.tsv`.
fn fixture_inputs() -> Vec<(String, String)> {
    let mut files: Vec<PathBuf> = fs::read_dir("../test/spec")
        .expect("the shared fixtures")
        .map(|entry| entry.expect("a directory entry").path())
        .filter(|path| path.extension().is_some_and(|ext| "tsv" == ext))
        .collect();
    files.sort();
    let mut inputs = Vec::new();
    for file in files {
        let body = fs::read_to_string(&file).expect("a fixture file");
        let name = file
            .file_name()
            .expect("a file name")
            .to_string_lossy()
            .to_string();
        for (index, raw) in body.replace("\r\n", "\n").split('\n').enumerate().skip(1) {
            if raw.is_empty() || (raw.starts_with('#') && !raw.contains('\t')) {
                continue;
            }
            let input = unescape_col(raw.split('\t').next().unwrap_or_default());
            inputs.push((format!("{name}:{}", index + 1), input));
        }
    }
    inputs
}

#[test]
fn every_fixture_database_streams_a_game_at_a_time() {
    let inputs = fixture_inputs();
    let mut read = 0;
    for (name, input) in &inputs {
        if assert_streams(name, input) {
            read += 1;
        }
    }
    // A floor, so that a loader that read nothing cannot pass: 197 of the
    // fixtures' inputs read as databases when this test was written.
    assert!(
        150 <= read,
        "only {read} of {} inputs read as databases",
        inputs.len()
    );
}

#[test]
fn a_database_of_many_games_streams_a_game_at_a_time() {
    // Every shape a game's tree can take while it is built: tags, a FEN
    // start, numbers, nags, both kinds of comment with commands, nested
    // variations, a variation before the first move, every result, and a
    // game the next one's tags end.
    let games = [
        "[Event \"a\"]\n[Site \"b\"]\n\n1. e4 e5 2. Nf3 {main} Nc6 $1 (2... d6 3. d4 (3. Bc4 $2) exd4) 3. Bb5 1-0",
        "[FEN \"8/8/8/8/8/8/8/8 b - - 0 12\"]\n\n12... e5 13. Nf3 {[%clk 0:01:00]} ; rest of line\n0-1",
        "{before} (1. d4) 1. e4 $14 {after} 1/2-1/2",
        "[Event \"no result\"]\n\n1. c4 c5",
        "[Event \"star\"]\n\n1. a3 *",
    ];
    let mut src = String::new();
    for round in 0..200 {
        src.push_str(games[round % games.len()]);
        src.push_str("\n\n");
    }
    assert!(assert_streams("many", &src), "the database reads");
    let (seen, _) = watch(&src).expect("the database reads");
    assert_eq!(200, seen.joined.len());
}
