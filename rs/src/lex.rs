/* Copyright (c) 2026 Richard Rodger, MIT License */

//! The lex matchers, in two families.
//!
//! The four in [`match_tokens`] are GATED: the engine only offers them a
//! slot where an active alternate names their token, which is what makes
//! `Event` a tag name inside `[…]` and a lex error in the movetext.
//!
//! The three in [`lex_matchers`] are deliberately NOT gated. `{`, `;` and
//! a first-column `%` mean the same thing wherever they appear, so they
//! live in the `lex.match` registry below the fixed matcher at 2e6.
//! Being hand-written is also what lets `pgnComment` span lines: the Rust
//! lexer advances by Unicode scalar and keeps `ri`/`ci` honest as it
//! goes, so a comment with a newline in it leaves every later error
//! position right — the bookkeeping TypeScript and Go each have to do by
//! hand in an `advance` helper.
//!
//! Every matcher reads the text through the lexer's window. A parse from
//! a reader (`Tabnas::parse_reader`) reads a grammar that declares
//! `lex.window` a window of the source at a time (admin ADR-30), and
//! [`crate::make`] declares it: [`Lexer::window`] is then the text from
//! the cursor to the window's end, and the source may go on past it. So
//! before a matcher decides, it asks the lexer to fill the window as far
//! as it reads ([`Lexer::fill`]): to the terminator it scans for
//! ([`scan_to`]), or the few characters a gated pattern reads
//! ([`fill_reach`], which the gated matchers' check, [`pgn_reach`], runs
//! before them). It then decides what it decides over the whole text, and
//! a parse from a reader gives the same games and errors as the text. In a
//! parse of a whole text the fill only answers.

use std::sync::Arc;

use regex::Regex;
use tabnas::{
    Context, LexCheckResult, LexMatcher, Lexer, MatchToken, MatchTokenMatcher, MatchTokenResult,
    Rule, Tin, Token, Value, TIN_CM,
};

use crate::actions::{comment_value, decompose, make_comment, move_value};
use crate::model::CommentKind;
use crate::san::{ends_token, move_number, nag, nag_strict, result, tag_name};

/// The token identities this plugin mints, in the order it mints them.
///
/// The ORDER is load-bearing. Match-token matchers run in tin-ascending
/// order, and tins are minted in call order, so `#RES` MUST come before
/// `#MVN` or the `1` of `1-0` lexes as a move number.
pub(crate) struct Tokens {
    pub(crate) res: Tin,
    pub(crate) san: Tin,
    pub(crate) mvn: Tin,
    pub(crate) nag: Tin,
    pub(crate) cmt: Tin,
    pub(crate) rmk: Tin,
    pub(crate) tgn: Tin,
}

/// Build the four gated matchers, plus the one that needs no bounds check
/// and so stays a plain regular expression.
pub(crate) fn match_tokens(tokens: &Tokens, san: Regex, strict: bool) -> Vec<MatchToken> {
    vec![
        callback_token("#RES", tokens.res, result_matcher()),
        callback_token("#SAN", tokens.san, san_matcher(san)),
        callback_token("#MVN", tokens.mvn, move_number_matcher()),
        callback_token("#NAG", tokens.nag, nag_matcher(strict)),
        MatchToken {
            name: "#TGN".to_string(),
            tin: tokens.tgn,
            matcher: MatchTokenMatcher::Regex(tag_name().clone()),
            eager: false,
        },
    ]
}

fn callback_token(
    name: &str,
    tin: Tin,
    matcher: impl Fn(&str) -> Option<MatchTokenResult> + Send + Sync + 'static,
) -> MatchToken {
    MatchToken {
        name: name.to_string(),
        tin,
        matcher: MatchTokenMatcher::Callback(Arc::new(matcher)),
        eager: false,
    }
}

/// A matched prefix, with no token value of its own: every action that
/// reads one of these reads `src`.
fn consumed(rest: &str, len: usize) -> Option<MatchTokenResult> {
    Some(MatchTokenResult::new(&rest[..len], Value::Undefined))
}

/// Three of the four markers are symbol tokens and so must end at a
/// non-symbol character; the asterisk "is a token by itself... It is self
/// terminating" (PGN spec 7), which is what lets `*1. e4` close one game
/// and open the next.
fn result_matcher() -> impl Fn(&str) -> Option<MatchTokenResult> + Send + Sync + 'static {
    |rest: &str| {
        let found = result().find(rest)?;
        let len = found.end();
        if "*" == found.as_str() || ends_token(rest, len, "/") {
            return consumed(rest, len);
        }
        None
    }
}

/// A move's token carries the move it spells, taken apart by the pattern
/// that cut it, for a reader of the rule passes (a transducer part), which
/// sees the tokens and not the tree. The move actions take the tree's move
/// from the token, so a move is taken apart once.
fn san_matcher(san: Regex) -> impl Fn(&str) -> Option<MatchTokenResult> + Send + Sync + 'static {
    move |rest: &str| {
        let found = san.find(rest)?;
        let len = found.end();
        if !ends_token(rest, len, "") {
            return None;
        }
        let source = &rest[..len];
        Some(MatchTokenResult::new(
            source,
            move_value(&decompose(&san, source)),
        ))
    }
}

/// A move number's token carries the number, its digits before any space
/// or period. The pattern allows nine digits at most, so the number always
/// fits, as the action reads it; `Undefined` is for a source the pattern
/// never cuts.
fn number_value(source: &str) -> Value {
    let digits: String = source.chars().take_while(char::is_ascii_digit).collect();
    match digits.parse::<u64>() {
        Ok(number) => Value::Number(number as f64),
        Err(_) => Value::Undefined,
    }
}

/// A glyph's token carries its number, the digits after its `$`. The
/// pattern allows nine digits at most, so the glyph always fits a `u32`, as
/// the action reads it; `Undefined` is for a source the pattern never cuts.
fn nag_value(source: &str) -> Value {
    match source.get(1..).map(str::parse::<u32>) {
        Some(Ok(glyph)) => Value::Number(glyph as f64),
        _ => Value::Undefined,
    }
}

/// A number written WITHOUT periods must still end its symbol token (PGN
/// spec 7), or `12e4` would lex as move number 12 plus the move e4 rather
/// than as the one bad token it is — and that also keeps the `1` of a
/// `1-0` or `1/2-1/2` termination marker out.
fn move_number_matcher() -> impl Fn(&str) -> Option<MatchTokenResult> + Send + Sync + 'static {
    |rest: &str| {
        let found = move_number().find(rest)?;
        let len = found.end();
        if found.as_str().contains('.') || ends_token(rest, len, "/") {
            return Some(MatchTokenResult::new(
                &rest[..len],
                number_value(&rest[..len]),
            ));
        }
        None
    }
}

/// PGN spec 8.2.4: a glyph value is from zero to 255. Import format is
/// not fussy about that; export format is, and says so in the pattern
/// rather than in a range check, so that an overlong literal is refused
/// outright instead of being cut short. The digit boundary is the
/// `(?!\d)` the canonical pattern ends on, checked one step later.
fn nag_matcher(strict: bool) -> impl Fn(&str) -> Option<MatchTokenResult> + Send + Sync + 'static {
    move |rest: &str| {
        let end = if strict {
            let end = nag_strict().find(rest)?.end();
            if rest.as_bytes().get(end).is_some_and(u8::is_ascii_digit) {
                return None;
            }
            end
        } else {
            nag().find(rest)?.end()
        };
        Some(MatchTokenResult::new(&rest[..end], nag_value(&rest[..end])))
    }
}

/// The three hand-written matchers, with the orders TypeScript and Go
/// give them: all below the fixed matcher at 2e6.
pub(crate) fn lex_matchers(tokens: &Tokens, commands: bool) -> Vec<LexMatcher> {
    vec![
        imperative(
            "pgnComment",
            1_200_000.0,
            comment_matcher(tokens.cmt, commands),
        ),
        imperative(
            "pgnRemark",
            1_300_000.0,
            remark_matcher(tokens.rmk, commands),
        ),
        imperative("pgnEscape", 1_500_000.0, escape_matcher()),
    ]
}

fn imperative(
    name: &str,
    order: f64,
    matcher: impl for<'source> Fn(&mut Lexer<'source>, &mut Rule, &mut Context) -> Option<Token>
        + Send
        + Sync
        + 'static,
) -> LexMatcher {
    LexMatcher {
        name: name.to_string(),
        order,
        matcher: None,
        imperative: Some(Arc::new(matcher)),
        factory: None,
    }
}

/// Where `find` finds what ends a token, as a byte offset into
/// [`Lexer::window`] at or after `from`, the window read on as far as it
/// takes; `None` once the source ends first, when the window holds the
/// rest of it. Each fill asks for twice what the window holds past the
/// cursor, so a long comment costs its length, not its square.
fn scan_to(
    lexer: &mut Lexer<'_>,
    from: usize,
    find: impl Fn(&str) -> Option<usize>,
) -> Option<usize> {
    let mut at = from;
    loop {
        let rest = lexer.window();
        if let Some(found) = find(&rest[at..]) {
            return Some(at + found);
        }
        at = rest.len();
        let held = rest.chars().count();
        lexer.fill(held.saturating_mul(2).max(held + 1));
        if lexer.window().len() <= at {
            return None;
        }
    }
}

/// The source from the cursor up to, but not including, the first line
/// break, or to the source's end.
fn line_at(lexer: &mut Lexer<'_>) -> String {
    let end = scan_to(lexer, 0, |text| text.find(['\n', '\r']));
    let rest = lexer.window();
    rest[..end.unwrap_or(rest.len())].to_string()
}

/// How far past the cursor the patterns of the gated matchers read, in
/// characters. The longest move is ten (`Qb1xd2++!!`, `bxc8=Q++!!`), and
/// the symbol-tail check reads one more; a glyph reads at most ten and a
/// termination marker eight (`1/2-1/2` and one more).
const REACH: usize = 11;

/// How far past the start of `rest` the move-number pattern reads: its
/// digits, nine at most, the spaces and tabs after them, the periods after
/// those, and one more character. The run of spaces and periods has no
/// bound of its own, so neither has this. Zero where no digit starts
/// `rest`.
fn number_reach(rest: &str) -> usize {
    let bytes = rest.as_bytes();
    let mut at = 0;
    while at < bytes.len() && at < 9 && bytes[at].is_ascii_digit() {
        at += 1;
    }
    if 0 == at {
        return 0;
    }
    while at < bytes.len() && matches!(bytes[at], b' ' | b'\t') {
        at += 1;
    }
    while at < bytes.len() && b'.' == bytes[at] {
        at += 1;
    }
    at + 1
}

/// Fill the window as far as a gated pattern reads ([`REACH`], or the run
/// of a move number), so that it matches over the window what it matches
/// over the whole text, the symbol-tail check included. Where the source
/// ends sooner, the window holds the rest of it.
fn fill_reach(lexer: &mut Lexer<'_>) {
    let mut ahead = REACH;
    loop {
        if !lexer.fill(ahead) {
            return;
        }
        let need = number_reach(lexer.window());
        if need <= ahead {
            return;
        }
        ahead = need.max(ahead.saturating_mul(2));
    }
}

/// `pgnReach`, the gated matchers' check (`match.check`). They
/// ([`match_tokens`]) are callbacks the engine hands the window's text
/// from the cursor, and a pattern may read past what it matches, or need
/// more than the window holds before it can match at all: over a window
/// that ends too soon it could fail, or cut a shorter token, where the
/// whole text gives a longer one. A callback cannot ask the lexer for
/// more, so the lexer runs this check before them at every token: it fills
/// the window as far as they read, and lets them run. A cut that runs to
/// the window's end, as a tag name may, is cut again by the lexer over a
/// wider window.
pub(crate) fn pgn_reach(lexer: &mut Lexer<'_>) -> LexCheckResult {
    fill_reach(lexer);
    LexCheckResult::Continue
}

/// The reference [`crate::chess`] registers [`pgn_reach`] under. The engine
/// installs a check through a reference, as a serialized grammar names one.
pub(crate) const REACH_REF: &str = "@pgn-reach";

/// The options document that makes [`pgn_reach`] the match tokens' check.
pub(crate) const REACH_CHECK: &str = r#"{"options":{"match":{"check":"@pgn-reach"}}}"#;

/// A comment's token carries the comment the tree holds, its `[%…]`
/// commands read as the `commands` option says, so a reader of the rule
/// passes (a transducer part) has it without the action that files it.
/// The closing brace may lie past the window's end: the comment is
/// unterminated only once the source ends first.
fn comment_matcher(
    tin: Tin,
    commands: bool,
) -> impl for<'source> Fn(&mut Lexer<'source>, &mut Rule, &mut Context) -> Option<Token>
       + Send
       + Sync
       + 'static {
    move |lexer, _rule, _context| {
        if !lexer.window().starts_with('{') {
            return None;
        }
        let Some(close) = scan_to(lexer, 1, |text| text.find('}')) else {
            // The span runs to the end of the source, so the diagnostic
            // shows the comment that never closed rather than one brace.
            let start = lexer.point().site.pos;
            let end = start + lexer.window().chars().count();
            return Some(lexer.bad_span("unterminated_comment", start, end));
        };
        let source = lexer.window()[..close + 1].to_string();
        let inner = source[1..source.len() - 1].to_string();
        let point = lexer.point();
        let comment = comment_value(&make_comment(CommentKind::Brace, inner, commands));
        let token = lexer.token("#CMT", tin, comment, source.as_str(), point);
        lexer.advance_chars(source.chars().count());
        Some(token)
    }
}

fn remark_matcher(
    tin: Tin,
    commands: bool,
) -> impl for<'source> Fn(&mut Lexer<'source>, &mut Rule, &mut Context) -> Option<Token>
       + Send
       + Sync
       + 'static {
    move |lexer, _rule, _context| {
        if !lexer.window().starts_with(';') {
            return None;
        }
        let source = line_at(lexer);
        let inner = source[1..].to_string();
        let point = lexer.point();
        let comment = comment_value(&make_comment(CommentKind::Line, inner, commands));
        let token = lexer.token("#RMK", tin, comment, source.as_str(), point);
        lexer.advance_chars(source.chars().count());
        Some(token)
    }
}

/// PGN spec 6: a `%` in the FIRST column escapes the rest of the line for
/// private use. A `%` anywhere else is an ordinary character.
fn escape_matcher(
) -> impl for<'source> Fn(&mut Lexer<'source>, &mut Rule, &mut Context) -> Option<Token>
       + Send
       + Sync
       + 'static {
    |lexer: &mut Lexer<'_>, _rule: &mut Rule, _context: &mut Context| {
        let point = lexer.point();
        if 1 != point.site.ci {
            return None;
        }
        if !lexer.window().starts_with('%') {
            return None;
        }
        let source = line_at(lexer);
        // #CM is in the IGNORE token set, so the parser never sees it.
        let token = lexer.token("#CM", TIN_CM, Value::Undefined, source.as_str(), point);
        lexer.advance_chars(source.chars().count());
        Some(token)
    }
}
