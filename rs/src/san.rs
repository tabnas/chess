/* Copyright (c) 2026 Richard Rodger, MIT License */

//! Lexical definitions: the regular part of the notation.
//!
//! One regular expression both LEXES a SAN move and TAKES IT APART, so
//! the token boundary and the field values cannot disagree. Do not add a
//! second pattern.

use std::sync::OnceLock;

use regex::{Captures, Regex};

use crate::model::{
    Annotation, CastleSide, CheckIndicator, Disambiguation, Move, Piece, PromotionPiece,
};

/// PGN spec 7: a symbol token continues through these characters, so a
/// token ending immediately before one has not really ended. Without this
/// guard `e2e4` would lex as the two moves `e2` and `e4` — the worst
/// possible outcome, because the parse then silently succeeds.
///
/// TypeScript writes the rule as a `(?!…)` lookahead inside the pattern.
/// Rust's `regex` crate has no lookahead, for the same reason Go's RE2
/// has none, so here it is a bounds check run after the match — the same
/// rule, checked one step later.
fn is_symbol_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'+' | b'#' | b'=' | b':' | b'-')
}

/// Whether a match of `end` bytes ends its symbol token.
///
/// `rest` is the source from the cursor, so `end` indexes the character
/// immediately after the match. `extra` names characters that also deny
/// the boundary: `/` for a move number and a termination marker, so that
/// the `1` of `1/2-1/2` can never lex as either.
///
/// Byte indexing is sound here because every character this rejects is
/// ASCII: a UTF-8 continuation or lead byte is neither a symbol character
/// nor anything `extra` can name.
pub(crate) fn ends_token(rest: &str, end: usize, extra: &str) -> bool {
    let bytes = rest.as_bytes();
    if end >= bytes.len() {
        return true;
    }
    let byte = bytes[end];
    if is_symbol_char(byte) {
        return false;
    }
    !extra.as_bytes().contains(&byte)
}

/// Build the regular expression that lexes and decomposes a SAN move.
///
/// `strict` narrows the same template to export format (PGN spec
/// 8.2.3.7): castling only as `O-O`/`O-O-O`, no `P` pawn prefix, `=`
/// before a promotion piece, and no suffix annotation.
pub fn san_pattern(strict: bool) -> Regex {
    let (castle, piece, promote, check, annotation) = if strict {
        ("O-O-O|O-O", "[KQRBN]", "=", "[+#]", "")
    } else {
        (
            "O-O-O|O-O|0-0-0|0-0",
            "[KQRBNP]",
            "=?",
            r"\+\+|[+#]",
            r"(?P<annotation>!!|\?\?|!\?|\?!|!|\?)?",
        )
    };
    let pattern = format!(
        concat!(
            "^(?:",
            "(?P<castle>{castle})",
            // Piece move: letter, optional disambiguation, optional
            // capture, target.
            "|(?P<piece>{piece})(?P<dfile>[a-h])?(?P<drank>[1-8])?",
            "(?P<pcapture>x)?(?P<pto>[a-h][1-8])",
            // Pawn move: origin file, optional capture, target rank,
            // promotion.
            "|(?P<pfile>[a-h])(?:x(?P<pxfile>[a-h]))?(?P<prank>[1-8])",
            "(?:{promote}(?P<promotion>[QRBN]))?",
            ")",
            "(?P<check>{check})?",
            "{annotation}",
        ),
        castle = castle,
        piece = piece,
        promote = promote,
        check = check,
        annotation = annotation,
    );
    Regex::new(&pattern).expect("the SAN pattern is a literal template")
}

/// Move number indication, PGN spec 8.2.2: digits, then zero or more
/// periods, with optional space between.
///
/// The number starts at 1 — the indication gives "the move number of the
/// immediately following white move", and there is no move zero — and
/// nine digits is far past any real game, which also stops an absurd
/// literal reaching the number parser. A number written WITHOUT periods
/// must still end its symbol token (spec 7): that check lives in the
/// matcher, because it is the part no regular expression here can carry.
pub(crate) fn move_number() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[1-9][0-9]{0,8}(?:[ \t]*\.+)?").expect("literal"))
}

/// Numeric annotation glyph, PGN spec 8.2.4. The value must be 0..255;
/// import format is not fussy about that, export format is, and that
/// check lives in the matcher.
pub(crate) fn nag() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\$[0-9]{1,9}").expect("literal"))
}

/// Game termination marker, PGN spec 8.2.6.
pub(crate) fn result() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^(?:1-0|0-1|1/2-1/2|\*)").expect("literal"))
}

/// Tag name, PGN spec 8.1: letters, digits and underscore only.
pub(crate) fn tag_name() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new("^[A-Za-z0-9_]+").expect("literal"))
}

/// Strip a traditional suffix annotation from a move as written.
///
/// The two-character spellings come first, so `e4!?` loses both
/// characters rather than one.
fn strip_annotation(san: &str) -> &str {
    for suffix in ["!!", "??", "!?", "?!", "!", "?"] {
        if let Some(head) = san.strip_suffix(suffix) {
            return head;
        }
    }
    san
}

/// Take a matched SAN move apart into the model.
pub(crate) fn build_move(captures: &Captures, whole: &str) -> Move {
    let group = |name: &str| captures.name(name).map(|found| found.as_str());
    let mut result = Move {
        san: strip_annotation(whole).to_string(),
        ..Move::default()
    };

    if let Some(castle) = group("castle") {
        result.piece = Piece::K;
        result.castle = Some(if 3 < castle.len() {
            CastleSide::Queen
        } else {
            CastleSide::King
        });
    } else if let Some(piece) = group("piece") {
        result.piece = piece
            .chars()
            .next()
            .and_then(Piece::from_letter)
            .unwrap_or_default();
        let file = group("dfile");
        let rank = group("drank");
        if file.is_some() || rank.is_some() {
            result.disambiguation = Some(Disambiguation {
                file: file.map(str::to_string),
                rank: rank.and_then(|rank| rank.parse().ok()),
            });
        }
        result.capture = group("pcapture").is_some();
        result.to = group("pto").map(str::to_string);
    } else {
        result.piece = Piece::P;
        let file = group("pfile").unwrap_or_default();
        let rank = group("prank").unwrap_or_default();
        if let Some(target) = group("pxfile") {
            result.disambiguation = Some(Disambiguation {
                file: Some(file.to_string()),
                rank: None,
            });
            result.capture = true;
            result.to = Some(format!("{target}{rank}"));
        } else {
            result.to = Some(format!("{file}{rank}"));
        }
        result.promotion = group("promotion")
            .and_then(|piece| piece.chars().next())
            .and_then(PromotionPiece::from_letter);
    }

    // `++` is an old spelling of a double check; it is still just a check.
    result.check = group("check").map(|check| {
        if "#" == check {
            CheckIndicator::Mate
        } else {
            CheckIndicator::Check
        }
    });
    result.annotation = group("annotation").and_then(Annotation::from_suffix);

    result
}

/// Take a SAN move string apart, for a caller that holds one already.
///
/// Returns `None` when the string is not a SAN move. The WHOLE string has
/// to be one move, so a prefix match does not count.
pub fn parse_san(src: &str, strict: bool) -> Option<Move> {
    let pattern = san_pattern(strict);
    let captures = pattern.captures(src)?;
    let whole = captures.get(0)?;
    if 0 != whole.start() || whole.as_str().len() != src.len() {
        return None;
    }
    Some(build_move(&captures, whole.as_str()))
}
