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

use std::sync::Arc;

use regex::Regex;
use tabnas::{
    Context, LexMatcher, Lexer, MatchToken, MatchTokenMatcher, MatchTokenResult, Rule, Tin, Token,
    Value, TIN_CM,
};

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

fn san_matcher(san: Regex) -> impl Fn(&str) -> Option<MatchTokenResult> + Send + Sync + 'static {
    move |rest: &str| {
        let found = san.find(rest)?;
        let len = found.end();
        ends_token(rest, len, "").then(|| consumed(rest, len))?
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
            return consumed(rest, len);
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
        if !strict {
            return consumed(rest, nag().find(rest)?.end());
        }
        let found = nag_strict().find(rest)?;
        let end = found.end();
        if rest.as_bytes().get(end).is_some_and(u8::is_ascii_digit) {
            return None;
        }
        consumed(rest, end)
    }
}

/// The three hand-written matchers, with the orders TypeScript and Go
/// give them: all below the fixed matcher at 2e6.
pub(crate) fn lex_matchers(tokens: &Tokens) -> Vec<LexMatcher> {
    vec![
        imperative("pgnComment", 1_200_000.0, comment_matcher(tokens.cmt)),
        imperative("pgnRemark", 1_300_000.0, remark_matcher(tokens.rmk)),
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

/// The source up to, but not including, the first line break.
fn line_from(rest: &str) -> &str {
    match rest.find(['\n', '\r']) {
        Some(end) => &rest[..end],
        None => rest,
    }
}

fn comment_matcher(
    tin: Tin,
) -> impl for<'source> Fn(&mut Lexer<'source>, &mut Rule, &mut Context) -> Option<Token>
       + Send
       + Sync
       + 'static {
    move |lexer, _rule, _context| {
        let rest = lexer.remaining();
        if !rest.starts_with('{') {
            return None;
        }
        let Some(close) = rest[1..].find('}') else {
            // The span runs to the end of the source, so the diagnostic
            // shows the comment that never closed rather than one brace.
            let start = lexer.point().site.pos;
            let end = lexer.source().chars().count();
            return Some(lexer.bad_span("unterminated_comment", start, end));
        };
        let source = rest[..close + 2].to_string();
        let inner = source[1..source.len() - 1].to_string();
        let point = lexer.point();
        let token = lexer.token("#CMT", tin, Value::String(inner), source.as_str(), point);
        lexer.advance_chars(source.chars().count());
        Some(token)
    }
}

fn remark_matcher(
    tin: Tin,
) -> impl for<'source> Fn(&mut Lexer<'source>, &mut Rule, &mut Context) -> Option<Token>
       + Send
       + Sync
       + 'static {
    move |lexer, _rule, _context| {
        let rest = lexer.remaining();
        if !rest.starts_with(';') {
            return None;
        }
        let source = line_from(rest).to_string();
        let inner = source[1..].to_string();
        let point = lexer.point();
        let token = lexer.token("#RMK", tin, Value::String(inner), source.as_str(), point);
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
        let rest = lexer.remaining();
        if !rest.starts_with('%') {
            return None;
        }
        let source = line_from(rest).to_string();
        // #CM is in the IGNORE token set, so the parser never sees it.
        let token = lexer.token("#CM", TIN_CM, Value::Undefined, source.as_str(), point);
        lexer.advance_chars(source.chars().count());
        Some(token)
    }
}
