/* Copyright (c) 2026 Richard Rodger, MIT License */

//! The parse model: what the notation said, and nothing else.
//!
//! There is deliberately no `from` field. A parser with no board cannot
//! resolve the origin of `Nf3`, so [`Move::disambiguation`] holds as much
//! of the origin square as was written and no more. Adding an inferred
//! field would make this a chess engine, and a bad one.
//!
//! Every type here serialises to exactly the JSON the TypeScript and Go
//! ports produce, which is what the shared `test/spec/*.tsv` fixtures
//! pin. A field the notation did not state is absent, never defaulted.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

/// Side to move. `w` is White, `b` is Black.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Side {
    #[serde(rename = "w")]
    White,
    #[serde(rename = "b")]
    Black,
}

impl Side {
    /// The other side. The move counter alternates through this.
    pub fn other(self) -> Self {
        match self {
            Side::White => Side::Black,
            Side::Black => Side::White,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Side::White => "w",
            Side::Black => "b",
        }
    }
}

/// A piece letter, PGN spec 8.2.3.2. Pawns are `P` even when unwritten.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Piece {
    P,
    N,
    B,
    R,
    Q,
    K,
}

impl Piece {
    /// The piece a SAN piece letter names, or `None` for anything else.
    pub fn from_letter(letter: char) -> Option<Self> {
        Some(match letter {
            'P' => Piece::P,
            'N' => Piece::N,
            'B' => Piece::B,
            'R' => Piece::R,
            'Q' => Piece::Q,
            'K' => Piece::K,
            _ => return None,
        })
    }
}

/// The four pieces a pawn may promote to, PGN spec 8.2.3.3.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PromotionPiece {
    N,
    B,
    R,
    Q,
}

impl PromotionPiece {
    pub fn from_letter(letter: char) -> Option<Self> {
        Some(match letter {
            'N' => PromotionPiece::N,
            'B' => PromotionPiece::B,
            'R' => PromotionPiece::R,
            'Q' => PromotionPiece::Q,
            _ => return None,
        })
    }
}

/// Which side of the board a castling move is on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CastleSide {
    King,
    Queen,
}

/// Check (`+`) or checkmate (`#`) indicator, PGN spec 8.2.3.5.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CheckIndicator {
    #[serde(rename = "+")]
    Check,
    #[serde(rename = "#")]
    Mate,
}

/// Traditional move suffix annotation, PGN spec 8.2.3.8.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Annotation {
    #[serde(rename = "!")]
    Good,
    #[serde(rename = "?")]
    Poor,
    #[serde(rename = "!!")]
    VeryGood,
    #[serde(rename = "??")]
    VeryPoor,
    #[serde(rename = "!?")]
    Speculative,
    #[serde(rename = "?!")]
    Questionable,
}

impl Annotation {
    /// The annotation a suffix spells, or `None` for anything else.
    pub fn from_suffix(suffix: &str) -> Option<Self> {
        Some(match suffix {
            "!" => Annotation::Good,
            "?" => Annotation::Poor,
            "!!" => Annotation::VeryGood,
            "??" => Annotation::VeryPoor,
            "!?" => Annotation::Speculative,
            "?!" => Annotation::Questionable,
            _ => return None,
        })
    }

    /// The glyph this suffix maps to, PGN spec 8.2.3.8 and 10. Use it to
    /// normalise an import-format annotation the way an export-format
    /// writer would.
    pub fn nag(self) -> u32 {
        match self {
            Annotation::Good => 1,
            Annotation::Poor => 2,
            Annotation::VeryGood => 3,
            Annotation::VeryPoor => 4,
            Annotation::Speculative => 5,
            Annotation::Questionable => 6,
        }
    }
}

/// Game termination marker, PGN spec 8.2.6.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GameResult {
    #[serde(rename = "1-0")]
    White,
    #[serde(rename = "0-1")]
    Black,
    #[serde(rename = "1/2-1/2")]
    Draw,
    #[serde(rename = "*")]
    Unfinished,
}

impl GameResult {
    /// The marker a termination token spells, or `None` for anything else.
    pub fn from_marker(marker: &str) -> Option<Self> {
        Some(match marker {
            "1-0" => GameResult::White,
            "0-1" => GameResult::Black,
            "1/2-1/2" => GameResult::Draw,
            "*" => GameResult::Unfinished,
            _ => return None,
        })
    }
}

/// Which comment syntax a [`Comment`] was written in, PGN spec 5.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CommentKind {
    /// `{ ... }`
    Brace,
    /// `; ...` to the end of the line.
    Line,
}

/// As much of a move's origin square as the notation states, PGN spec
/// 8.2.3.4. Never inferred.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Disambiguation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rank: Option<u8>,
}

/// One `[%name operand,operand]` command inside a comment.
///
/// Not from the 1994 standard — from the *PGN Specification Supplement*
/// (Cowderoy, Bulsink, Templeton, Bentzen, Feist and Zakharov; final
/// draft 8 September 2001), which defines the syntax and four time
/// commands: `clk`, `egt`, `emt` and `mct`. The `eval`, `csl` and `cal`
/// commands seen in lichess and ChessBase exports use the same syntax
/// without being part of it, so this parses the syntax and interprets
/// none of the names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Command {
    pub name: String,
    /// Operands in order. A quoted operand keeps its content, not its
    /// quotes.
    pub args: Vec<String>,
}

/// A comment, PGN spec 5. `text` is the body verbatim, markup included.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Comment {
    pub kind: CommentKind,
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub commands: Vec<Command>,
}

/// One move, as written. Fields absent from the notation are absent here.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Move {
    /// The move as written, without any suffix annotation.
    pub san: String,
    pub piece: Piece,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disambiguation: Option<Disambiguation>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub capture: bool,
    /// Destination square, e.g. `e4`. Absent for castling.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub promotion: Option<PromotionPiece>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub castle: Option<CastleSide>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check: Option<CheckIndicator>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub annotation: Option<Annotation>,
    /// Fullmove number: stated by a move number indication, else counted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number: Option<u32>,
    /// Side to move: implied by the count, or by a `...` indication.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub side: Option<Side>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub nags: Vec<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub comments: Vec<Comment>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub variations: Vec<Line>,
}

/// A move sequence: a game's mainline, or one variation.
///
/// An annotation belongs to the move it follows. `comments`, `nags` and
/// `variations` here hold the ones that precede the line's first move and
/// so have no move to belong to — they annotate the starting position.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Line {
    pub moves: Vec<Move>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub comments: Vec<Comment>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub nags: Vec<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub variations: Vec<Line>,
}

/// One game: a tag pair section plus a movetext section, PGN spec 8.
///
/// `line` is flattened, so a game and a variation marshal to the same
/// shape — the Rust spelling of the TypeScript `interface Game extends
/// Line` and the Go anonymous embed.
///
/// `tags` keeps insertion order. PGN spec 8.1 admits any name of letters,
/// digits and underscore, `__proto__` among them; that name is a hazard
/// for a JavaScript object and merely a string here.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Game {
    pub tags: IndexMap<String, String>,
    #[serde(flatten)]
    pub line: Line,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<GameResult>,
}

/// A PGN database is a sequence of games, PGN spec 18.
pub type Database = Vec<Game>;

impl Default for Piece {
    /// A move with no piece letter is a pawn move, PGN spec 8.2.3.2.
    fn default() -> Self {
        Piece::P
    }
}

#[allow(clippy::trivially_copy_pass_by_ref)]
fn is_false(flag: &bool) -> bool {
    !*flag
}
