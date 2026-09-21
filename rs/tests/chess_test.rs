/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

//! What a `test/spec/*.tsv` fixture cannot express: option handling,
//! error text, the exported helpers, and the properties that are this
//! port's own. Everything expressible as `input -> JSON` belongs in the
//! shared fixtures instead — see ../../test/AGENTS.md.

use std::thread;

use tabnas::{Tabnas, Value};
use tabnas_chess::{
    annotation_nag, chess, make, model_of, parse, parse_game, parse_san, strip_commands,
    CastleSide, ChessOptions, Command, Comment, CommentKind, Disambiguation, Game, Move, Piece,
    Side, Start, VERSION,
};

fn options(start: Start) -> ChessOptions {
    ChessOptions {
        start,
        ..Default::default()
    }
}

fn must_game(src: &str) -> Game {
    parse_game(src, &Default::default())
        .unwrap_or_else(|error| panic!("parse {src:?}: {error}"))
        .unwrap_or_else(|| panic!("parse {src:?}: no game"))
}

fn must_game_with(src: &str, options: &ChessOptions) -> Game {
    parse_game(src, options)
        .unwrap_or_else(|error| panic!("parse {src:?}: {error}"))
        .unwrap_or_else(|| panic!("parse {src:?}: no game"))
}

fn must_move(src: &str, options: &ChessOptions) -> Move {
    let tn = make(options).expect("the grammar installs");
    let value = tn
        .parse(src)
        .unwrap_or_else(|error| panic!("{src:?}: {error}"));
    model_of(&value).unwrap_or_else(|error| panic!("{src:?}: {error}"))
}

// --- The plugin surface --------------------------------------------------

#[test]
fn exports_a_version() {
    let mut field = VERSION.split('.');
    for _ in 0..3 {
        let part = field.next().unwrap_or("");
        assert!(
            !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()),
            "VERSION {VERSION:?} is not a semver"
        );
    }
}

/// The plugin sets the error MESSAGES, which are the grammar's business.
/// It must not set `color`, which is the engine's: a caller who installs
/// it onto an engine they configured themselves keeps their choice.
/// `make` is where the colour gate belongs, because `make` builds the
/// engine.
#[test]
fn leaves_a_callers_colour_choice_alone() {
    let mut tn = Tabnas::new();
    tn.options.color.active = true;
    chess(&mut tn, &Default::default()).expect("the grammar installs");
    let error = tn.parse("1. e4 zz").expect_err("expected a parse error");
    assert!(
        error.to_string().contains('\u{1b}'),
        "the plugin overrode the caller's colour option: {error}"
    );
}

#[test]
fn installs_on_a_bare_engine() {
    let mut tn = Tabnas::new();
    chess(&mut tn, &Default::default()).expect("the grammar installs");
    let games: Vec<Game> = model_of(&tn.parse("e4").expect("e4 parses")).expect("a database");
    assert_eq!(1, games.len());
    assert_eq!("e4", games[0].line.moves[0].san);
}

#[test]
fn empty_source_is_an_empty_database() {
    for src in ["", "   \n\n  "] {
        let games =
            parse(src, &Default::default()).unwrap_or_else(|error| panic!("{src:?}: {error}"));
        assert!(games.is_empty(), "{src:?}: got {} games", games.len());
    }
    assert_eq!(None, parse_game("", &Default::default()).expect("no error"));
}

#[test]
fn parse_forces_the_database_start_rule() {
    // `start` is not merely absent from the signature: a caller who set it
    // would otherwise get a return type that lies.
    let games = parse("e4", &options(Start::Move)).expect("e4 parses");
    assert_eq!(1, games.len());
    assert_eq!("e4", games[0].line.moves[0].san);
}

// --- Start rules ---------------------------------------------------------

#[test]
fn move_start_rule_returns_one_move() {
    assert_eq!(
        Move {
            san: "Qa6xb7#".to_string(),
            piece: Piece::Q,
            disambiguation: Some(Disambiguation {
                file: Some("a".to_string()),
                rank: Some(6),
            }),
            capture: true,
            to: Some("b7".to_string()),
            check: Some(tabnas_chess::CheckIndicator::Mate),
            ..Move::default()
        },
        must_move("Qa6xb7#", &options(Start::Move))
    );
}

#[test]
fn a_bare_move_has_no_number_or_side() {
    let played = must_move("e4", &options(Start::Move));
    assert_eq!(None, played.number);
    assert_eq!(None, played.side);
}

#[test]
fn move_start_rule_rejects_a_move_sequence() {
    let tn = make(&options(Start::Move)).expect("the grammar installs");
    assert!(tn.parse("e4 e5").is_err());
}

#[test]
fn movetext_start_rule_returns_a_line() {
    let tn = make(&options(Start::Movetext)).expect("the grammar installs");
    let value = tn.parse("1. e4 e5").expect("the line parses");
    let line: tabnas_chess::Line = model_of(&value).expect("a line");
    assert_eq!(2, line.moves.len());
    assert!(line.comments.is_empty());
}

// --- SAN -----------------------------------------------------------------

#[test]
fn parse_san_matches_the_parser() {
    for san in ["e4", "exd5", "Nbd7", "O-O", "e8=Q+", "Qh4e1"] {
        let mut want = must_game(san).line.moves.remove(0);
        want.number = None;
        want.side = None;
        assert_eq!(Some(want), parse_san(san, false), "{san}");
    }
}

#[test]
fn parse_san_rejects_a_non_move() {
    // A prefix match is not a match: the whole string must be the move.
    for src in ["e9", "hello", "", "e4e5"] {
        assert_eq!(None, parse_san(src, false), "{src:?} was accepted");
    }
}

#[test]
fn a_run_together_pair_of_moves_is_rejected_not_split() {
    // Without the symbol-tail check this would silently be e2, e4 — a
    // wrong parse, which is worse than an error.
    assert!(parse("e2e4", &Default::default()).is_err());
}

#[test]
fn suffix_annotation_is_split_off_the_san() {
    let played = &must_game("e4!? *").line.moves[0];
    assert_eq!("e4", played.san);
    assert_eq!(
        Some(tabnas_chess::Annotation::Speculative),
        played.annotation
    );
}

#[test]
fn annotation_nag_covers_every_suffix_annotation() {
    for (suffix, glyph) in [
        ("!", 1),
        ("?", 2),
        ("!!", 3),
        ("??", 4),
        ("!?", 5),
        ("?!", 6),
    ] {
        assert_eq!(Some(glyph), annotation_nag(suffix), "{suffix}");
    }
    assert_eq!(None, annotation_nag("!?!"));
}

#[test]
fn castling_names_the_side_of_the_board() {
    assert_eq!(
        Some(CastleSide::King),
        must_game("O-O *").line.moves[0].castle
    );
    assert_eq!(
        Some(CastleSide::Queen),
        must_game("O-O-O *").line.moves[0].castle
    );
    assert_eq!(Piece::K, must_game("O-O *").line.moves[0].piece);
}

// --- Strict (export) format ----------------------------------------------

#[test]
fn strict_mode_rejects_what_only_import_format_allows() {
    let strict = ChessOptions {
        strict: true,
        ..Default::default()
    };
    for (src, why) in [
        ("0-0", "zero castling"),
        ("0-0-0", "zero long castling"),
        ("Pe4", "pawn letter prefix"),
        ("e8Q", "promotion without ="),
        ("e4!", "suffix annotation"),
        ("e4++", "double check"),
    ] {
        let lenient = must_game(&format!("{src} *"));
        assert_eq!(1, lenient.line.moves.len(), "lenient rejected {why}");
        assert!(
            parse(&format!("{src} *"), &strict).is_err(),
            "strict accepted {why}"
        );
    }
}

#[test]
fn both_formats_accept_canonical_san() {
    let strict = ChessOptions {
        strict: true,
        ..Default::default()
    };
    for src in ["e4", "O-O", "O-O-O", "exd5", "e8=Q", "Qa6xb7#", "Nbd7"] {
        let src = format!("{src} *");
        assert_eq!(1, must_game(&src).line.moves.len(), "lenient: {src}");
        assert_eq!(
            1,
            must_game_with(&src, &strict).line.moves.len(),
            "strict: {src}"
        );
    }
}

// --- Comments ------------------------------------------------------------

#[test]
fn commands_are_parsed_by_default_and_text_is_kept_verbatim() {
    let played = &must_game("1. e4 { good [%clk 0:05:00] [%cal Ra1a8,Gb1b8] } *")
        .line
        .moves[0];
    assert_eq!(
        vec![Comment {
            kind: CommentKind::Brace,
            text: " good [%clk 0:05:00] [%cal Ra1a8,Gb1b8] ".to_string(),
            commands: vec![
                Command {
                    name: "clk".to_string(),
                    args: vec!["0:05:00".to_string()],
                },
                Command {
                    name: "cal".to_string(),
                    args: vec!["Ra1a8".to_string(), "Gb1b8".to_string()],
                },
            ],
        }],
        played.comments
    );
}

#[test]
fn commands_can_be_switched_off() {
    let bare = ChessOptions {
        commands: false,
        ..Default::default()
    };
    let game = must_game_with("1. e4 {[%clk 0:05:00]} *", &bare);
    assert_eq!(
        vec![Comment {
            kind: CommentKind::Brace,
            text: "[%clk 0:05:00]".to_string(),
            commands: Vec::new(),
        }],
        game.line.moves[0].comments
    );
}

#[test]
fn strip_commands_removes_the_markup() {
    assert_eq!("good move", strip_commands(" good [%clk 0:05:00] move "));
    assert_eq!("no markup", strip_commands("no markup"));
    // An operand may hold the comma and the bracket its own grammar uses,
    // which is why this is a scanner and not a regular expression.
    assert_eq!(
        "cited",
        strip_commands(r#"[%src "Lasker, Common Sense in Chess (1896), p. 12]"] cited"#)
    );
}

#[test]
fn an_unterminated_brace_comment_is_an_error() {
    let error = parse("1. e4 { never closed", &Default::default()).expect_err("an error");
    assert_eq!("unterminated_comment", error.code());
    assert!(error.to_string().contains("never closed"), "{error}");
}

#[test]
fn a_brace_comment_may_span_lines_and_keeps_later_positions_honest() {
    let game = must_game("1. e4 {line one\nline two} e5 *");
    assert_eq!("line one\nline two", game.line.moves[0].comments[0].text);
    let error = parse("1. e4 {line one\nline two}\nzz", &Default::default()).expect_err("an error");
    assert!(
        error.to_string().contains("3:1"),
        "expected 3:1, got {error}"
    );
}

// --- The escape mechanism ------------------------------------------------

#[test]
fn a_first_column_percent_escapes_the_line() {
    assert_eq!(2, must_game("%private data\n1. e4 e5 *").line.moves.len());
}

#[test]
fn a_percent_elsewhere_is_not_an_escape() {
    assert!(parse("1. e4 %private\n", &Default::default()).is_err());
}

// --- Tag pairs -----------------------------------------------------------

#[test]
fn a_repeated_tag_name_keeps_the_first_value() {
    let game = must_game("[Event \"one\"]\n[Event \"two\"]\n*");
    assert_eq!("one", game.tags["Event"]);
}

#[test]
fn quote_and_backslash_escapes() {
    let game = must_game("[Note \"a \\\"quoted\\\" \\\\ word\"]\n*");
    assert_eq!("a \"quoted\" \\ word", game.tags["Note"]);
}

#[test]
fn a_tag_value_may_be_empty() {
    let game = must_game("[Event \"\"]\n*");
    assert_eq!(Some(&String::new()), game.tags.get("Event"));
}

#[test]
fn a_malformed_tag_pair_is_an_error() {
    for src in ["[Event]\n*", "[Event \"x\"\n*", "[\"x\" Event]\n*"] {
        assert!(
            parse(src, &Default::default()).is_err(),
            "{src:?} was accepted"
        );
    }
}

/// PGN spec 8.1 admits any name of letters, digits and underscore. In
/// JavaScript `__proto__` is a hazard that costs the tag map its
/// prototype; in Rust it is a string like any other, and this pins that
/// it stays one.
#[test]
fn a_name_another_language_reserves_is_still_a_tag() {
    let game = must_game("[__proto__ \"x\"]\n[constructor \"y\"]\n*");
    assert_eq!("x", game.tags["__proto__"]);
    assert_eq!("y", game.tags["constructor"]);
}

// --- Move numbering ------------------------------------------------------

#[test]
fn numbering_is_counted_when_unstated() {
    let counted: Vec<(u64, Side)> = must_game("e4 e5 Nf3 Nc6 *")
        .line
        .moves
        .iter()
        .map(|played| (played.number.unwrap(), played.side.unwrap()))
        .collect();
    assert_eq!(
        vec![
            (1, Side::White),
            (1, Side::Black),
            (2, Side::White),
            (2, Side::Black)
        ],
        counted
    );
}

#[test]
fn a_stated_number_resynchronises_the_count() {
    assert_eq!(
        Some(15),
        must_game("1. e4 e5 15. Nf3 *").line.moves[2].number
    );
}

#[test]
fn three_dots_mean_black_to_move() {
    let game = must_game("4... e5 5. Nf3 *");
    assert_eq!(Some(Side::Black), game.line.moves[0].side);
    assert_eq!(Some(Side::White), game.line.moves[1].side);
}

#[test]
fn a_fen_tag_sets_the_starting_number_and_side() {
    let game =
        must_game("[FEN \"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 12\"]\ne5 Nf3 *");
    assert_eq!(Some(12), game.line.moves[0].number);
    assert_eq!(Some(Side::Black), game.line.moves[0].side);
    assert_eq!(Some(13), game.line.moves[1].number);
    assert_eq!(Some(Side::White), game.line.moves[1].side);
}

#[test]
fn a_malformed_fen_tag_falls_back_to_move_one_white() {
    let game = must_game("[FEN \"nonsense\"]\ne4 *");
    assert_eq!(Some(1), game.line.moves[0].number);
    assert_eq!(Some(Side::White), game.line.moves[0].side);
}

#[test]
fn a_variation_starts_on_the_move_it_replaces() {
    let game = must_game("1. e4 e5 (1... c5 2. Nf3) 2. Nf3 *");
    let variation = &game.line.moves[1].variations[0];
    assert_eq!(Some(1), variation.moves[0].number);
    assert_eq!(Some(Side::Black), variation.moves[0].side);
    assert_eq!(Some(2), variation.moves[1].number);
    assert_eq!(Some(Side::White), variation.moves[1].side);
}

// --- Errors --------------------------------------------------------------

#[test]
fn an_illegal_square_is_rejected() {
    for src in ["1. e9 *", "1. Zf3 *"] {
        assert!(
            parse(src, &Default::default()).is_err(),
            "{src:?} was accepted"
        );
    }
}

#[test]
fn unbalanced_parentheses_are_rejected() {
    for src in ["1. e4 (1. d4 *", "1. e4) *"] {
        assert!(
            parse(src, &Default::default()).is_err(),
            "{src:?} was accepted"
        );
    }
}

#[test]
fn the_error_names_the_row_and_column() {
    let error = parse("[Event \"x\"]\n\n1. e4 zz", &Default::default()).expect_err("an error");
    assert!(
        error.to_string().contains("3:7"),
        "expected 3:7, got {error}"
    );
}

#[test]
fn the_error_speaks_chess_not_grammar() {
    let error = parse("1. e4 zz", &Default::default()).expect_err("an error");
    assert_eq!("unexpected", error.code());
    assert!(
        error.to_string().contains("not chess notation"),
        "got {error}"
    );
}

// --- This port's own properties ------------------------------------------

/// The running move number and side hang off a `MapRef`'s `meta`, which
/// nothing serialises. If they ever moved into the value map, the parse
/// result would carry bookkeeping a consumer never asked for — and every
/// fixture would go red at once, so this pins the narrower claim directly.
#[test]
fn line_bookkeeping_never_reaches_the_result() {
    let tn = make(&Default::default()).expect("the grammar installs");
    let value = tn.parse("1. e4 e5 (1... c5) *").expect("it parses");
    let json = tabnas_chess::to_json(&value).to_string();
    assert!(!json.contains("chess:"), "bookkeeping leaked: {json}");
    for key in ["number", "side"] {
        assert!(json.contains(key), "expected {key} on the moves: {json}");
    }
}

/// A hostile `FEN` tag can put the count at the top of a 32-bit range,
/// and the next move has to advance past it rather than panic. A fixture
/// pins the value; this pins that the counter is wide enough to reach it
/// from the typed model, which is where a narrowed field would show up
/// first.
#[test]
fn a_huge_fen_move_number_survives_the_count() {
    let game = must_game("[FEN \"8/8/8/8/8/8/8/8 b - - 0 4294967295\"]\ne5 Nf3 *");
    assert_eq!(Some(4_294_967_295), game.line.moves[0].number);
    assert_eq!(Some(4_294_967_296), game.line.moves[1].number);
}

/// `Value` holds every number as an `f64`. A fixture that says
/// `{"rank":1}` means the integer, and so does a consumer.
#[test]
fn integral_numbers_come_back_as_integers() {
    let tn = make(&Default::default()).expect("the grammar installs");
    let value = tn.parse("1. Qh4e1 $14 *").expect("it parses");
    let json = tabnas_chess::to_json(&value).to_string();
    assert!(json.contains("\"rank\":4"), "{json}");
    assert!(json.contains("\"number\":1"), "{json}");
    assert!(json.contains("[14]"), "{json}");
    assert!(
        !json.contains(".0"),
        "a number came back as a float: {json}"
    );
}

/// `Game` flattens `Line`, the way TypeScript extends it and Go embeds
/// it. A round-trip proves the flattened shape is the one the engine
/// produced.
#[test]
fn the_typed_model_round_trips() {
    let game = must_game("[Event \"x\"]\n1. e4 {note} e5 (1... c5) $1 1-0");
    let json = serde_json::to_value(&game).expect("it serialises");
    assert_eq!(
        game,
        serde_json::from_value::<Game>(json).expect("it reads back")
    );
}

#[test]
fn options_read_from_a_plugin_option_bag() {
    let mut tn = Tabnas::new();
    tn.use_plugin(
        tabnas_chess::plugin(),
        Some(Value::from_json(&serde_json::json!({"start": "move"}))),
    )
    .expect("the plugin installs");
    let played: Move = model_of(&tn.parse("e4").expect("it parses")).expect("a move");
    assert_eq!("e4", played.san);
}

/// The bag is read field by field, as `ts/src/chess.ts` reads it
/// (`true === options?.strict`, `false !== options?.commands`): a value
/// of the wrong type leaves THAT option at its default and the others as
/// given. Read as one struct, one bad field silently discarded them all,
/// and `{"strict": true, "commands": "no"}` installed lenient.
#[test]
fn a_bad_option_does_not_discard_the_good_ones() {
    // `strict` stays on although `commands` is not a boolean.
    let mut tn = Tabnas::new();
    tn.use_plugin(
        tabnas_chess::plugin(),
        Some(Value::from_json(
            &serde_json::json!({"strict": true, "commands": "no"}),
        )),
    )
    .expect("the plugin installs");
    assert!(tn.parse("e4! *").is_err(), "strict was discarded");
    let games: Vec<Game> =
        model_of(&tn.parse("e4 {[%clk 0:01]} *").expect("it parses")).expect("a database");
    assert_eq!(
        1,
        games[0].line.moves[0].comments[0].commands.len(),
        "commands fell back to on, as in TypeScript"
    );

    // `start` stays `move` although `strict` is not a boolean.
    let mut tn = Tabnas::new();
    tn.use_plugin(
        tabnas_chess::plugin(),
        Some(Value::from_json(
            &serde_json::json!({"start": "move", "strict": 1}),
        )),
    )
    .expect("the plugin installs");
    assert!(tn.parse("e4 e5 *").is_err(), "start was discarded");
    let played: Move = model_of(&tn.parse("e4!").expect("lenient, so e4! parses")).expect("a move");
    assert_eq!("e4", played.san);
}

/// TypeScript hands an unknown `start` to the engine and gets `undefined`
/// back from every parse. There is no honest Rust spelling of that, so
/// the install refuses it and says which names it knows.
#[test]
fn an_unknown_start_rule_is_refused_at_install() {
    let mut tn = Tabnas::new();
    let Err(error) = tn.use_plugin(
        tabnas_chess::plugin(),
        Some(Value::from_json(&serde_json::json!({"start": "bogus"}))),
    ) else {
        panic!("an unknown start rule installed");
    };
    assert!(error.to_string().contains("bogus"), "{error}");
}

/// The cached parser behind an optionless [`parse`] is written once and
/// read by every caller after it. Eight threads racing the first call is
/// what would find a `OnceLock` used wrongly.
#[test]
fn parse_is_race_free_on_first_use() {
    let workers: Vec<_> = (0..8)
        .map(|_| thread::spawn(|| parse("1. e4 e5 *", &Default::default())))
        .collect();
    for worker in workers {
        let games = worker.join().expect("no panic").expect("it parses");
        assert_eq!(1, games.len());
    }
}

/// The canonical plugin splits a `FEN` tag on JavaScript's `\s` and trims
/// a command operand with JavaScript's `trim()`, and that class is not
/// Rust's `char::is_whitespace`: U+FEFF is whitespace only to JavaScript,
/// U+0085 only to Rust. A port that split on the Rust class read
/// `b<U+0085>-` as one field and `b<U+FEFF>-` as three, the reverse of
/// TypeScript, so the side and number came out wrong on exactly those
/// two characters.
#[test]
fn whitespace_inside_a_fen_tag_is_javascripts_class() {
    // U+FEFF separates fields in TypeScript, so this is Black to move at 7.
    let game = must_game("[FEN \"8/8/8/8/8/8/8/8 b\u{FEFF}- - 0 7\"]\ne4 e5 *");
    assert_eq!(Some(7), game.line.moves[0].number);
    assert_eq!(Some(Side::Black), game.line.moves[0].side);

    // U+0085 does not, so `b<NEL>-` is one field that is not `b`, and the
    // fullmove field is not where the number is looked for.
    let game = must_game("[FEN \"8/8/8/8/8/8/8/8 b\u{85}- - 0 7\"]\ne4 e5 *");
    assert_eq!(Some(1), game.line.moves[0].number);
    assert_eq!(Some(Side::White), game.line.moves[0].side);
}

/// The same class trims a bare command operand and the stripped text.
#[test]
fn command_operands_are_trimmed_with_javascripts_class() {
    let game = must_game("1. e4 {[%a b\u{FEFF}] [%c \u{85}d ]} *");
    let commands = &game.line.moves[0].comments[0].commands;
    assert_eq!(vec!["b".to_string()], commands[0].args);
    assert_eq!(vec!["\u{85}d".to_string()], commands[1].args);

    assert_eq!("x", strip_commands("x\u{FEFF}"));
    assert_eq!("\u{85}x\u{85}", strip_commands("\u{85}x\u{85}"));
}
