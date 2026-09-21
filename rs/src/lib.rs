/* Copyright (c) 2026 Richard Rodger, MIT License */

//! `tabnas-chess` — a Tabnas grammar plugin for chess notation.
//!
//! Parses PGN (Portable Game Notation) and the SAN (Standard Algebraic
//! Notation) moves inside it, and returns a plain, JSON-serialisable game
//! model.
//!
//! ```
//! let games = tabnas_chess::parse(
//!     "[Event \"F/S Return Match\"]\n\n1. e4 e5 2. Nf3 1/2-1/2",
//!     &Default::default(),
//! )
//! .unwrap();
//! assert_eq!(games[0].tags["Event"], "F/S Return Match");
//! assert_eq!(games[0].line.moves[0].san, "e4");
//! ```
//!
//! This is a port of the canonical TypeScript implementation, and a
//! sibling of the Go one. The grammar is not duplicated: all three
//! runtimes embed the same JSON, generated from `chess-grammar.jsonic` by
//! `ts/embed-grammar.js`. See `../ts/doc/concepts.md` for why the model
//! and the grammar look the way they do.
//!
//! # What this port does differently, and why
//!
//! The behaviour is identical — that is what the shared
//! `test/spec/*.tsv` fixtures pin — but three things are spelled
//! differently because the language is:
//!
//! - **The parse result is a [`tabnas::Value`], not a native tree.** The
//!   engine's node is a `Value`, so the actions build one, and
//!   [`parse`] deserialises it into [`Game`]. The typed model is
//!   therefore the JSON shape, rather than a second description of it.
//! - **Boundary guards are code, not lookahead.** Rust's `regex` crate
//!   has no `(?!…)`, so the PGN spec 7 symbol-tail rule is a check the
//!   matcher runs after the match, exactly as in the Go port.
//! - **Line bookkeeping lives in `MapRef::meta`**, which nothing
//!   serialises — this port's answer to the non-enumerable `Symbol`
//!   property in TypeScript and the `json:"-"` field in Go.

use std::io::IsTerminal;
use std::sync::OnceLock;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tabnas::{GrammarSetting, Plugin, PluginError, TabnasError, Value};

/// The README's examples, compiled and run as doctests. An example that
/// does not work is a documentation bug, and this is what finds it.
#[cfg(doctest)]
#[doc = include_str!("../README.md")]
struct Readme;

mod actions;
mod commands;
mod lex;
mod model;
mod san;

pub use commands::strip_commands;
pub use model::{
    Annotation, CastleSide, CheckIndicator, Command, Comment, CommentKind, Database,
    Disambiguation, Game, GameResult, Line, Move, Piece, PromotionPiece, Side,
};
pub use san::parse_san;
use san::san_pattern;
pub use tabnas::Tabnas;

// --- BEGIN EMBEDDED chess-grammar.jsonic ---
const GRAMMAR_TEXT: &str = r##"
{
  "rule": {
    "pgn": {
      "open": [
        {
          "s": "#ZZ",
          "g": "pgn,empty"
        },
        {
          "s": "#HEAD",
          "p": "gameitem",
          "b": 1,
          "g": "pgn,game"
        }
      ],
      "close": [
        {
          "s": "#ZZ",
          "g": "pgn,end"
        }
      ]
    },
    "gameitem": {
      "open": [
        {
          "s": "#HEAD",
          "p": "game",
          "b": 1,
          "g": "game,item"
        }
      ],
      "close": [
        {
          "s": "#HEAD",
          "r": "gameitem",
          "b": 1,
          "g": "game,next"
        },
        {
          "s": "#ZZ",
          "g": "game,end"
        }
      ]
    },
    "game": {
      "open": [
        {
          "s": "#OS",
          "p": "tag",
          "b": 1,
          "g": "game,tag"
        },
        {
          "s": "#ELEM",
          "p": "movetext",
          "b": 1,
          "g": "game,movetext"
        },
        {
          "s": "#RES",
          "a": "@result-open",
          "g": "game,result"
        }
      ],
      "close": [
        {
          "s": "#OS",
          "p": "tag",
          "b": 1,
          "c": "@more-tags",
          "g": "game,tag"
        },
        {
          "s": "#ELEM",
          "p": "movetext",
          "b": 1,
          "c": "@no-result",
          "g": "game,movetext"
        },
        {
          "s": "#RES",
          "a": "@result-close",
          "g": "game,result"
        },
        {
          "s": "#ZZ",
          "g": "game,end"
        },
        {
          "b": 1,
          "g": "game,more"
        }
      ]
    },
    "tag": {
      "open": [
        {
          "s": "#OS",
          "p": "tagbody",
          "g": "tag,open"
        }
      ],
      "close": [
        {
          "s": "#CS",
          "g": "tag,close"
        }
      ]
    },
    "tagbody": {
      "open": [
        {
          "s": "#TGN #ST",
          "a": "@tag",
          "g": "tag,pair"
        }
      ],
      "close": [
        {
          "s": "#CS",
          "b": 1,
          "g": "tag,end"
        }
      ]
    },
    "movetext": {
      "open": [
        {
          "s": "#ELEM",
          "p": "element",
          "b": 1,
          "g": "movetext,elem"
        }
      ],
      "close": [
        {
          "s": "#EEND",
          "b": 1,
          "g": "movetext,end"
        },
        {
          "s": "#ZZ",
          "g": "movetext,end"
        },
        {
          "b": 1,
          "g": "movetext,more"
        }
      ]
    },
    "element": {
      "open": [
        {
          "s": "#SAN",
          "a": "@move",
          "g": "elem,move"
        },
        {
          "s": "#MVN",
          "a": "@number",
          "g": "elem,number"
        },
        {
          "s": "#NAG",
          "a": "@nag",
          "g": "elem,nag"
        },
        {
          "s": "#CMT",
          "a": "@brace-comment",
          "g": "elem,comment"
        },
        {
          "s": "#RMK",
          "a": "@line-comment",
          "g": "elem,comment"
        },
        {
          "s": "#OP",
          "p": "rav",
          "b": 1,
          "u": {
            "rav": true
          },
          "g": "elem,rav"
        }
      ],
      "close": [
        {
          "s": "#ELEM",
          "r": "element",
          "b": 1,
          "g": "elem,next"
        },
        {
          "s": "#EEND",
          "b": 1,
          "g": "elem,end"
        },
        {
          "s": "#ZZ",
          "g": "elem,end"
        },
        {
          "b": 1,
          "g": "elem,more"
        }
      ]
    },
    "rav": {
      "open": [
        {
          "s": "#OP",
          "p": "movetext",
          "g": "rav,open"
        }
      ],
      "close": [
        {
          "s": "#CP",
          "g": "rav,close"
        }
      ]
    },
    "move": {
      "open": [
        {
          "s": "#SAN",
          "a": "@bare-move",
          "g": "move,san"
        }
      ],
      "close": [
        {
          "s": "#ZZ",
          "g": "move,end"
        },
        {
          "b": 1,
          "g": "move,more"
        }
      ]
    }
  }
}"##;
// --- END EMBEDDED chess-grammar.jsonic ---

/// This crate's version. It MUST equal `ts/package.json` "version":
/// `tests/version_test.rs` fails the build if they drift.
pub const VERSION: &str = "0.1.7";

/// Which rule to parse from, and so what a parse returns.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Start {
    /// A whole database, returning `Vec<Game>`.
    #[default]
    Pgn,
    /// One game.
    Game,
    /// An element sequence with no tag section.
    Movetext,
    /// A single SAN move.
    Move,
}

impl Start {
    pub fn as_str(self) -> &'static str {
        match self {
            Start::Pgn => "pgn",
            Start::Game => "game",
            Start::Movetext => "movetext",
            Start::Move => "move",
        }
    }
}

/// Plugin options. [`Default`] is import format, comment commands
/// parsed, whole-database start rule — the same defaults as the other two
/// ports, with no "was it set?" flag needed to say so.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ChessOptions {
    /// Require export-format SAN (PGN spec 8.2.3.7): castling only as
    /// `O-O`/`O-O-O`, no `P` pawn prefix, `=` before a promotion piece,
    /// no `!`/`?` suffix annotations, and glyph values within 0..=255.
    pub strict: bool,

    /// Parse `[%name arg,arg]` markup inside comments into
    /// [`Comment::commands`]. The comment text is kept verbatim either
    /// way.
    pub commands: bool,

    /// Which rule to parse from.
    pub start: Start,
}

impl Default for ChessOptions {
    fn default() -> Self {
        ChessOptions {
            strict: false,
            commands: true,
            start: Start::Pgn,
        }
    }
}

/// What a parse can fail with: the engine's diagnostic, or a result that
/// did not fit the model.
#[derive(Debug)]
pub enum ChessError {
    /// The notation was rejected. Boxed because a [`TabnasError`] carries
    /// the whole diagnostic, source context included.
    Parse(Box<TabnasError>),
    /// The parse succeeded but its shape is not a game database. Nothing
    /// this crate's own grammar produces reaches this.
    Model(String),
}

impl ChessError {
    /// The engine's error code, for a rejection; `"model"` otherwise.
    pub fn code(&self) -> &str {
        match self {
            ChessError::Parse(error) => &error.code,
            ChessError::Model(_) => "model",
        }
    }
}

impl std::fmt::Display for ChessError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ChessError::Parse(error) => error.fmt(formatter),
            ChessError::Model(detail) => formatter.write_str(detail),
        }
    }
}

impl std::error::Error for ChessError {}

impl From<TabnasError> for ChessError {
    fn from(error: TabnasError) -> Self {
        ChessError::Parse(Box::new(error))
    }
}

/// Install the chess-notation grammar on a bare Tabnas engine.
///
/// Use this to add chess notation to an engine you are configuring
/// yourself; [`make`] is the short way to a ready one.
pub fn chess(tn: &mut Tabnas, options: &ChessOptions) -> Result<(), PluginError> {
    let pattern = san_pattern(options.strict);

    // Mint the tins before the matchers close over them. The ORDER is
    // load-bearing: match-token matchers run in tin-ascending order, so
    // `#RES` must come before `#MVN` or the `1` of `1-0` lexes as a move
    // number.
    let tokens = lex::Tokens {
        res: tn.token("#RES"),
        san: tn.token("#SAN"),
        mvn: tn.token("#MVN"),
        nag: tn.token("#NAG"),
        cmt: tn.token("#CMT"),
        rmk: tn.token("#RMK"),
        tgn: tn.token("#TGN"),
    };

    // PGN's brackets are not JSON's: `[` `]` delimit tag pairs, `(` `)`
    // delimit variations, and `{` `}` are comment markers handled by a
    // matcher, so the JSON-shaped fixed tokens are retired.
    for retired in ["#OB", "#CB", "#CL", "#CA"] {
        tn.options.fixed.tokens.shift_remove(retired);
    }
    let open_square = tn.token_with_source("#OS", "[");
    let open_paren = tn.token_with_source("#OP", "(");
    let close_paren = tn.token_with_source("#CP", ")");
    // `]` closes a tag pair, which only the grammar names, so its tin is
    // needed by no token set here.
    tn.token_with_source("#CS", "]");

    for matcher in lex::match_tokens(&tokens, pattern.clone(), options.strict) {
        tn.options
            .match_tokens
            .insert(matcher.name.clone(), matcher);
    }
    for matcher in lex::lex_matchers(&tokens) {
        tn.options
            .lex
            .matchers
            .insert(matcher.name.clone(), matcher);
    }
    tn.options.lex.empty_result = Value::array(Vec::new());

    // What may start a movetext element.
    tn.options.token_set.insert(
        "ELEM".to_string(),
        vec![
            tokens.san, tokens.mvn, tokens.nag, tokens.cmt, tokens.rmk, open_paren,
        ],
    );
    // What may start a game: a tag pair, an element, or a bare result.
    tn.options.token_set.insert(
        "HEAD".to_string(),
        vec![
            open_square,
            tokens.san,
            tokens.mvn,
            tokens.nag,
            tokens.cmt,
            tokens.rmk,
            open_paren,
            tokens.res,
        ],
    );
    // What ends an element sequence, to be re-read by an outer rule.
    tn.options.token_set.insert(
        "EEND".to_string(),
        vec![tokens.res, open_square, close_paren],
    );

    // Every lexical atom of PGN has its own matcher above; a bareword or
    // a bare number outside them is not chess notation.
    tn.options.text.lex = false;
    tn.options.number.lex = false;
    tn.options.value.lex = false;
    // PGN's own comment styles are tokens this grammar keeps, not
    // whitespace the lexer may discard.
    tn.options.comment.lex = false;

    // PGN spec 7: a tag value is double-quoted, on one line, and the only
    // escapes are \" and \\.
    tn.options.string.chars = "\"".to_string();
    tn.options.string.multi_chars = String::new();
    tn.options.string.escape_strict = true;
    for escape in ['n', 't', 'r', 'b', 'f', 'v', '0'] {
        tn.options.string.escape.remove(&escape);
    }
    tn.options.string.allow_unknown = true;

    /* The engine's error text is written for someone debugging a grammar:
     * it reports the character class that did not match. Someone who fed
     * this a PGN file wants the vocabulary of chess notation instead, so
     * the plugin replaces the message for every code this grammar can
     * actually reach — `unexpected`, `unterminated_comment` and
     * `unprintable`, plus `unterminated_string` for completeness.
     *
     * Set here rather than in `parse` so that building the engine by hand
     * gets them too. Kept identical to ts/src/chess.ts.
     *
     * `{src}` is the offending source text, and is EMPTY when the
     * notation simply ran out. The messages have to read sensibly either
     * way, which is why none of them ends on the interpolation; the hint
     * carries the ran-out case.
     */
    for (code, message) in [
        ("unexpected", "not chess notation: {src}"),
        ("unterminated_comment", "this comment is never closed"),
        ("unterminated_string", "this tag value has no closing quote"),
        ("unprintable", "a tag value cannot contain a line break"),
    ] {
        tn.options
            .error
            .insert(code.to_string(), message.to_string());
    }

    for (code, hint) in [
        (
            "unexpected",
            "
Chess notation is a sequence of move numbers, moves, comments,
variations, glyphs and a result. Check for a stray character, or for
something that looks like a move but is not one — Ke9 names no square,
Nx names no destination. If the notation simply stops here, look instead
for a variation \"(\" or a tag \"[\" that was never closed.",
        ),
        (
            "unterminated_comment",
            "
A brace comment runs from the opening brace to the next closing brace
(PGN spec 5). To put a comment on the rest of a line, start it with a
semicolon instead.",
        ),
        (
            "unterminated_string",
            "
A tag value is a double-quoted string that ends on the line it starts on
(PGN spec 8.1).",
        ),
        (
            "unprintable",
            "
A tag value is a double-quoted string on a single line (PGN spec 8.1).
The tag pair is probably missing its closing quote, so the value ran on
into the next line.",
        ),
    ] {
        tn.options.hint.insert(code.to_string(), hint.to_string());
    }

    tn.options.rule.start = options.start.as_str().to_string();

    actions::register(tn, pattern, options.commands);

    tn.grammar_json_with_setting(GRAMMAR_TEXT, &GrammarSetting::groups("chess"))
        .map(|_| ())
        .map_err(|error| PluginError(error.to_string()))
}

/// The plugin descriptor, for [`Tabnas::use_plugin`]. Options are read
/// from the plugin option bag, so a caller who has one already can hand
/// it over; [`chess`] is the typed way in.
///
/// The bag is read field by field, as the canonical plugin reads it:
/// `strict` is on only when it is exactly `true`, `commands` is off only
/// when it is exactly `false`, and a field of any other type leaves that
/// ONE option at its default. A `start` that names no rule is refused
/// here, at install, rather than at the first parse.
pub fn plugin() -> Plugin {
    Plugin::new("Chess", |tn, options| {
        chess(tn, &options_from_value(options)?)
    })
    .with_defaults(to_option_value(&ChessOptions::default()))
}

/// Read the option bag the way `ts/src/chess.ts` does — each field on
/// its own terms, `true === options?.strict`, `false !== options?.commands`,
/// `options?.start || 'pgn'` — rather than as one struct. Read as a
/// struct, `{"strict": true, "commands": "no"}` failed as a whole and
/// silently installed the lenient defaults: one bad field cost the good
/// ones.
fn options_from_value(value: &Value) -> Result<ChessOptions, PluginError> {
    let bag = value.to_json();
    let field = |name: &str| bag.get(name);

    let strict = Some(&serde_json::Value::Bool(true)) == field("strict");
    let commands = Some(&serde_json::Value::Bool(false)) != field("commands");

    let start = match field("start") {
        // Everything JavaScript calls falsy means "the default".
        None | Some(serde_json::Value::Null) | Some(serde_json::Value::Bool(false)) => Start::Pgn,
        Some(serde_json::Value::Number(number)) if Some(0.0) == number.as_f64() => Start::Pgn,
        Some(serde_json::Value::String(name)) => match name.as_str() {
            "" | "pgn" => Start::Pgn,
            "game" => Start::Game,
            "movetext" => Start::Movetext,
            "move" => Start::Move,
            _ => {
                return Err(PluginError(format!(
                    "chess: start names no rule: {name:?} (one of pgn, game, movetext, move)"
                )))
            }
        },
        Some(other) => {
            return Err(PluginError(format!(
                "chess: start must be a rule name, not {other}"
            )))
        }
    };

    Ok(ChessOptions {
        strict,
        commands,
        start,
    })
}

/// Whether to colour an error message.
///
/// The engine turns colour on unconditionally, which is right for a
/// terminal and wrong everywhere else: in a log file or a CI transcript
/// the escape codes are noise wrapped around the message. Follow the
/// convention every other tool follows — colour a real terminal and
/// honour NO_COLOR.
///
/// Only [`make`] and the functions built on it apply this. It builds the
/// whole engine, so the choice is its to make; a caller who builds their
/// own engine has already been handed the `color` option and should not
/// have it taken back by a plugin.
fn colour() -> bool {
    match std::env::var("NO_COLOR") {
        Ok(value) if !value.is_empty() => false,
        _ => std::io::stdout().is_terminal(),
    }
}

/// Build a Tabnas engine with the chess grammar installed.
///
/// Reuse the result: building the grammar dominates a parse.
///
/// This goes through [`plugin`] rather than calling [`chess`] directly,
/// so the instance records the plugin and its resolved options — which is
/// what puts `chess` in `Tabnas::describe` and in a diagnostic's
/// `plugins` list.
pub fn make(options: &ChessOptions) -> Result<Tabnas, PluginError> {
    let mut tn = Tabnas::new();
    tn.options.color.active = colour();
    tn.use_plugin(plugin(), Some(to_option_value(options)))?;
    Ok(tn)
}

fn to_option_value(options: &ChessOptions) -> Value {
    Value::from_json(&serde_json::to_value(options).expect("the options serialise"))
}

fn default_parser() -> Result<&'static Tabnas, PluginError> {
    static DEFAULT: OnceLock<Result<Tabnas, PluginError>> = OnceLock::new();
    DEFAULT
        .get_or_init(|| make(&ChessOptions::default()))
        .as_ref()
        .map_err(Clone::clone)
}

/// Parse a PGN database (zero or more games).
///
/// `start` is forced to [`Start::Pgn`]: this function parses a database,
/// and its return type says so. Use [`make`] for another entry rule.
pub fn parse(src: &str, options: &ChessOptions) -> Result<Database, ChessError> {
    let value = if &ChessOptions::default() == options {
        default_parser()
            .map_err(|error| ChessError::Model(error.to_string()))?
            .parse(src)?
    } else {
        let options = ChessOptions {
            start: Start::Pgn,
            ..options.clone()
        };
        make(&options)
            .map_err(|error| ChessError::Model(error.to_string()))?
            .parse(src)?
    };
    model_of(&value)
}

/// Parse a single game, or `None` if the source holds none.
pub fn parse_game(src: &str, options: &ChessOptions) -> Result<Option<Game>, ChessError> {
    Ok(parse(src, options)?.into_iter().next())
}

/// Read a parse result into the typed model.
///
/// The engine hands back a [`Value`]; this is the one step between that
/// and [`Game`]. It is public because a caller who built their own engine
/// — for `start = "move"`, say — needs it too.
pub fn model_of<T: DeserializeOwned>(value: &Value) -> Result<T, ChessError> {
    serde_json::from_value(to_json(value)).map_err(|error| ChessError::Model(error.to_string()))
}

/// Render a parse result as JSON.
///
/// [`Value`] carries every number as an `f64`, the way JavaScript does,
/// and `serde_json` writes an `f64` back as `1.0`. The model's numbers —
/// a rank, a move number, a glyph — are integers, and a fixture that
/// says `{"rank":1}` means the integer, so an integral value goes back as
/// one. Everything else is [`Value::to_json`] unchanged.
pub fn to_json(value: &Value) -> serde_json::Value {
    match value {
        Value::Number(number) => {
            if number.fract() == 0.0 && number.is_finite() {
                if 0.0 <= *number && *number <= u64::MAX as f64 {
                    return serde_json::Value::from(*number as u64);
                }
                if i64::MIN as f64 <= *number && *number <= i64::MAX as f64 {
                    return serde_json::Value::from(*number as i64);
                }
            }
            value.to_json()
        }
        Value::Array(items) => serde_json::Value::Array(items.iter().map(to_json).collect()),
        Value::Object(entries) => serde_json::Value::Object(
            entries
                .iter()
                .map(|(key, value)| (key.clone(), to_json(value)))
                .collect(),
        ),
        Value::ListRef(list) => serde_json::Value::Array(list.value.iter().map(to_json).collect()),
        Value::MapRef(map) => serde_json::Value::Object(
            map.value
                .iter()
                .map(|(key, value)| (key.clone(), to_json(value)))
                .collect(),
        ),
        _ => value.to_json(),
    }
}

/// The glyph a traditional suffix annotation maps to, PGN spec 8.2.3.8
/// and 10, or `None` for anything that is not one. Use it to normalise an
/// import-format annotation the way an export-format writer would.
pub fn annotation_nag(suffix: &str) -> Option<u32> {
    Annotation::from_suffix(suffix).map(Annotation::nag)
}
