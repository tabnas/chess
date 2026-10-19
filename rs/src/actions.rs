/* Copyright (c) 2026 Richard Rodger, MIT License */

//! The grammar actions: what each matched alternate does to the model.
//!
//! The grammar carries `@ref` strings and no functions, so it stays
//! shippable as data; the plugin binds these before installing it.
//!
//! # Where a line is built
//!
//! A "line" is a game or a variation, and the two are the same shape.
//! The lines being built live in the parse's context, innermost last, in
//! `u["chess:lines"]`: a game of a database pushes itself there, `rav` a
//! variation, and `tag`, `tagbody`, `movetext` and `element` write into
//! the line on top. A variation leaves the stack when the `element` that
//! opened it closes, and joins the move it follows; a game leaves it when
//! its `gameitem` closes, and joins the database whole.
//!
//! So the database is the only container in the engine's tree: `pgn`
//! makes it its node, every other rule inherits that cell, and nothing
//! but a finished game is ever stored in it. A streaming host follows a
//! parse through its rule nodes (tabnas-transduce's rule-event adapter
//! streams a container that is a node as its rules close, and walks one
//! that arrives complete), so a database streams a game at a time and a
//! game never leaves before its last annotation and its result have
//! joined it. A game cannot leave sooner, since a move's annotations,
//! comments and variations follow the move (PGN spec 8.2.3.8, 5, 8.2.5).
//!
//! A `game` or `movetext` that is the start rule has no database to join:
//! the line it builds is its node, which the actions write into whenever
//! the stack is empty (`with_line`).
//!
//! The running move number and side to move are bookkeeping, not model,
//! so they hang off a [`MapRef`]'s `meta` map — which neither
//! `Serialize` nor `to_json` emits. That is this port's spelling of the
//! non-enumerable `Symbol` property in TypeScript and the `json:"-"`
//! field in Go: the parse result is plain JSON with no clean-up pass.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use indexmap::IndexMap;
use regex::Regex;
use serde::Serialize;
use tabnas::{Context, MapRef, Tabnas, Value};

use crate::commands::{js_space, scan_commands};
use crate::model::{
    Annotation, CastleSide, CheckIndicator, Comment, CommentKind, GameResult, Move, Piece,
    PromotionPiece, Side,
};
use crate::san::build_move;

// --- Node helpers --------------------------------------------------------

const COUNT_NUMBER: &str = "chess:number";
const COUNT_SIDE: &str = "chess:side";

/// The context entry holding the lines being built, innermost last.
const LINES: &str = "chess:lines";

/// The lines being built: the game, then each variation open inside it.
fn lines(context: &mut Context) -> &mut Vec<Value> {
    let entry = context
        .u
        .entry(LINES.to_string())
        .or_insert_with(|| Value::array(Vec::new()));
    if entry.as_array_mut().is_none() {
        *entry = Value::array(Vec::new());
    }
    entry
        .as_array_mut()
        .expect("the entry was just made an array")
}

/// The running `{number, side}` a line counts moves with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Count {
    number: u64,
    side: Side,
}

impl Default for Count {
    fn default() -> Self {
        Count {
            number: 1,
            side: Side::White,
        }
    }
}

fn map_ref(value: IndexMap<String, Value>) -> Value {
    Value::MapRef(Arc::new(MapRef {
        value,
        implicit: false,
        meta: IndexMap::new(),
    }))
}

fn as_map(value: &Value) -> Option<&MapRef> {
    match value {
        Value::MapRef(map) => Some(map),
        _ => None,
    }
}

fn as_map_mut(value: &mut Value) -> Option<&mut MapRef> {
    match value {
        Value::MapRef(map) => Some(Arc::make_mut(map)),
        _ => None,
    }
}

/// A fresh line: a variation, or a `movetext` parsed on its own.
fn new_line() -> Value {
    let mut value = IndexMap::new();
    value.insert("moves".to_string(), Value::array(Vec::new()));
    map_ref(value)
}

/// A fresh game. `tags` keeps insertion order, and PGN spec 8.1's
/// `__proto__` is just a key here — the hazard the other two ports guard
/// against does not exist in Rust.
fn new_game() -> Value {
    let mut value = IndexMap::new();
    value.insert("tags".to_string(), Value::object(IndexMap::new()));
    value.insert("moves".to_string(), Value::array(Vec::new()));
    map_ref(value)
}

pub(crate) fn to_value<T: Serialize>(item: &T) -> Value {
    Value::from_json(&serde_json::to_value(item).expect("the model always serialises"))
}

fn array_entry<'map>(map: &'map mut MapRef, field: &str) -> &'map mut Vec<Value> {
    map.value
        .entry(field.to_string())
        .or_insert_with(|| Value::array(Vec::new()))
        .as_array_mut()
        .expect("the entry was just made an array")
}

fn object_array_entry<'value>(
    value: &'value mut Value,
    field: &str,
) -> Option<&'value mut Vec<Value>> {
    value
        .as_object_mut()?
        .entry(field.to_string())
        .or_insert_with(|| Value::array(Vec::new()))
        .as_array_mut()
}

fn has_moves(map: &MapRef) -> bool {
    matches!(map.value.get("moves"), Some(Value::Array(moves)) if !moves.is_empty())
}

/// Append to the last move of a line, or — when the line has no move yet
/// — to the line itself, where an annotation of the starting position
/// belongs.
fn annotate(node: &mut Value, field: &str, item: Value) {
    let Some(map) = as_map_mut(node) else {
        return;
    };
    if has_moves(map) {
        let moves = array_entry(map, "moves");
        if let Some(last) = moves.last_mut() {
            if let Some(list) = object_array_entry(last, field) {
                list.push(item);
            }
        }
        return;
    }
    array_entry(map, field).push(item);
}

fn push_move(node: &mut Value, item: Value) {
    if let Some(map) = as_map_mut(node) {
        array_entry(map, "moves").push(item);
    }
}

fn count_of(node: &Value) -> Option<Count> {
    let map = as_map(node)?;
    let number = match map.meta.get(COUNT_NUMBER)? {
        Value::Number(number) => *number as u64,
        _ => return None,
    };
    let side = match map.meta.get(COUNT_SIDE)? {
        Value::String(side) if "b" == side => Side::Black,
        Value::String(_) => Side::White,
        _ => return None,
    };
    Some(Count { number, side })
}

fn set_count(node: &mut Value, count: Count) {
    if let Some(map) = as_map_mut(node) {
        map.meta
            .insert(COUNT_NUMBER.to_string(), Value::Number(count.number as f64));
        map.meta.insert(
            COUNT_SIDE.to_string(),
            Value::String(count.side.as_str().to_string()),
        );
    }
}

/// A game with a `FEN` tag does not start at move 1 with White to move,
/// and PGN spec 9.7 says that tag is where to look: fields 2 and 6 of a
/// FEN record are the active colour and the fullmove number.
fn start_of(node: &Value) -> Count {
    let mut count = Count::default();
    let Some(map) = as_map(node) else {
        return count;
    };
    let Some(Value::Object(tags)) = map.value.get("tags") else {
        return count;
    };
    let Some(Value::String(fen)) = tags.get("FEN") else {
        return count;
    };
    // Split on JavaScript's whitespace class, as the canonical plugin
    // does (`fen.trim().split(/\s+/)`), not on Rust's.
    let field: Vec<&str> = fen
        .split(js_space)
        .filter(|field| !field.is_empty())
        .collect();
    if Some(&"b") == field.get(1) {
        count.side = Side::Black;
    }
    if let Some(number) = field.get(5) {
        if !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit()) {
            if let Ok(number) = number.parse::<u64>() {
                if 0 < number {
                    count.number = number;
                }
            }
        }
    }
    count
}

/// The line's counter, seeded from the tag section on first use.
fn counter(node: &mut Value) -> Count {
    if let Some(count) = count_of(node) {
        return count;
    }
    let count = start_of(node);
    set_count(node, count);
    count
}

/// The number and side of the line's last move, for a variation that
/// replaces it.
fn last_move_count(node: &Value) -> Option<Count> {
    let map = as_map(node)?;
    let Some(Value::Array(moves)) = map.value.get("moves") else {
        return None;
    };
    let Value::Object(last) = moves.last()? else {
        return None;
    };
    let number = match last.get("number")? {
        Value::Number(number) => *number as u64,
        _ => return None,
    };
    let side = match last.get("side")? {
        Value::String(side) if "b" == side => Side::Black,
        Value::String(_) => Side::White,
        _ => return None,
    };
    Some(Count { number, side })
}

/// The contents of a string-valued token.
fn text_of(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Text(text) => Some(text.string.clone()),
        _ => None,
    }
}

pub(crate) fn make_comment(kind: CommentKind, text: String, parse: bool) -> Comment {
    let commands = if parse {
        scan_commands(&text).0
    } else {
        Vec::new()
    };
    Comment {
        kind,
        text,
        commands,
    }
}

/// Take a lexed SAN token apart. The `None` arm is unreachable: the token
/// was cut by this very pattern, so it matches by construction.
pub(crate) fn decompose(pattern: &Regex, src: &str) -> Move {
    match pattern.captures(src) {
        Some(captures) => build_move(&captures, src),
        None => Move {
            san: src.to_string(),
            ..Move::default()
        },
    }
}

// --- Registration --------------------------------------------------------

/// Bind every `@ref` the grammar names. Registration happens BEFORE the
/// grammar is installed: the engine resolves references at install time
/// and fails the whole installation if one is missing or mistyped.
pub(crate) fn register(tn: &mut Tabnas, san: Regex, commands: bool) {
    let pattern = Arc::new(san);

    // The database is a plain array, and the only container in the
    // engine's tree: every other rule inherits this cell.
    tn.state_action_ref("@pgn-bo", |rule, _context| {
        rule.node = Rc::new(RefCell::new(Value::array(Vec::new())));
        Ok(())
    });

    // The game is complete: it leaves the stack and joins the database.
    tn.state_action_ref("@gameitem-bc", |rule, context| {
        let Some(game) = lines(context).pop() else {
            return Ok(());
        };
        if let Some(database) = rule.node.borrow_mut().as_array_mut() {
            database.push(game);
        }
        Ok(())
    });

    // A game of a database is built on the stack. As the start rule it
    // has no database to join, and is its own node.
    tn.state_action_ref("@game-bo", |rule, context| {
        if rule.node.borrow().is_undefined() {
            rule.node = Rc::new(RefCell::new(new_game()));
        } else {
            lines(context).push(new_game());
        }
        Ok(())
    });

    // `movetext` normally writes into the line it is in. As the start
    // rule it has no line, so it makes one its node.
    tn.state_action_ref("@movetext-bo", |rule, _context| {
        if rule.node.borrow().is_undefined() {
            rule.node = Rc::new(RefCell::new(new_line()));
        }
        Ok(())
    });

    // The line is the game: `tag` and `tagbody` write into it.
    tn.action_with_context("@tag", |rule, context| {
        let Some(name) = rule.o0().map(|token| token.src.as_str().to_string()) else {
            return Ok(());
        };
        let Some(value) = rule.o1().and_then(|token| text_of(&token.val)) else {
            return Ok(());
        };
        with_line(rule, context, |line| {
            let Some(map) = as_map_mut(line) else {
                return;
            };
            let Some(tags) = map
                .value
                .get_mut("tags")
                .and_then(|tags| tags.as_object_mut())
            else {
                return;
            };
            // PGN spec 8.1: a tag name should not repeat; the first wins,
            // as a reader has no better rule for choosing between them.
            if !tags.contains_key(&name) {
                tags.insert(name, Value::String(value));
            }
        });
        Ok(())
    });

    tn.action_with_context("@result-open", |rule, context| {
        let marker = rule.o0().map(|token| token.src.as_str().to_string());
        set_result(rule, context, marker);
        Ok(())
    });

    tn.action_with_context("@result-close", |rule, context| {
        let marker = rule.c0().map(|token| token.src.as_str().to_string());
        set_result(rule, context, marker);
        Ok(())
    });

    // A `[` after the movetext has started belongs to the next game, not
    // to this one's tag section.
    tn.alt_condition("@more-tags", |rule, context| {
        with_line(rule, context, |line| {
            as_map(line).is_none_or(|map| !has_moves(map) && !map.value.contains_key("result"))
        })
        .unwrap_or(true)
    });

    // PGN spec 8.2.6: the termination marker is the last element of a
    // movetext section, so movetext after one belongs to the next game.
    // This is what lets `*1. e4 *` be two games.
    tn.alt_condition("@no-result", |rule, context| {
        with_line(rule, context, |line| {
            as_map(line).is_none_or(|map| !map.value.contains_key("result"))
        })
        .unwrap_or(true)
    });

    let san = pattern.clone();
    tn.action_with_context("@move", move |rule, context| {
        let Some(token) = rule.o0().map(|token| move_of(&san, token)) else {
            return Ok(());
        };
        with_line(rule, context, |line| {
            let count = counter(line);
            let played = numbered(&token, count);
            set_count(
                line,
                match count.side {
                    Side::White => Count {
                        number: count.number,
                        side: Side::Black,
                    },
                    // Saturating, because the number can come from a
                    // `FEN` tag and PGN spec 9.7 bounds that field
                    // nowhere. A panic here would turn hostile input into
                    // an `internal` diagnostic; JavaScript, counting in
                    // doubles, just keeps going.
                    Side::Black => Count {
                        number: count.number.saturating_add(1),
                        side: Side::White,
                    },
                },
            );
            push_move(line, played);
        });
        Ok(())
    });

    let san = pattern.clone();
    tn.action_with_context("@bare-move", move |rule, _context| {
        let Some(played) = rule.o0().map(|token| move_of(&san, token)) else {
            return Ok(());
        };
        rule.node = Rc::new(RefCell::new(played));
        Ok(())
    });

    // PGN spec 8.2.2: the integer is the fullmove number of the move that
    // follows. Import format allows any number of periods, but three or
    // more is the export-format spelling for "Black to move", so it is
    // worth honouring where it appears.
    tn.action_with_context("@number", |rule, context| {
        let Some(src) = rule.o0().map(|token| token.src.as_str().to_string()) else {
            return Ok(());
        };
        let digits: String = src.chars().take_while(char::is_ascii_digit).collect();
        with_line(rule, context, |line| {
            let mut count = counter(line);
            if let Ok(number) = digits.parse::<u64>() {
                count.number = number;
            }
            match src.matches('.').count() {
                0 => {}
                1 => count.side = Side::White,
                _ => count.side = Side::Black,
            }
            set_count(line, count);
        });
        Ok(())
    });

    tn.action_with_context("@nag", |rule, context| {
        let Some(src) = rule.o0().map(|token| token.src.as_str().to_string()) else {
            return Ok(());
        };
        let Ok(glyph) = src[1..].parse::<u32>() else {
            return Ok(());
        };
        with_line(rule, context, |line| {
            annotate(line, "nags", Value::Number(glyph as f64))
        });
        Ok(())
    });

    tn.action_with_context("@brace-comment", move |rule, context| {
        comment_action(rule, context, CommentKind::Brace, commands);
        Ok(())
    });

    tn.action_with_context("@line-comment", move |rule, context| {
        comment_action(rule, context, CommentKind::Line, commands);
        Ok(())
    });

    // A variation replaces the move it follows, so it starts on that
    // move's number and side, not on the next one. It is built on the
    // stack, above the line it is in.
    tn.state_action_ref("@rav-bo", |rule, context| {
        let count = with_line(rule, context, |parent| match last_move_count(parent) {
            Some(count) => count,
            None => counter(parent),
        })
        .unwrap_or_default();
        let mut line = new_line();
        set_count(&mut line, count);
        lines(context).push(line);
        Ok(())
    });

    // The variation is complete: it leaves the stack and joins the move
    // it follows, or, when it follows no move, the line's starting
    // position.
    tn.state_action_ref("@element-bc", |rule, context| {
        if Some(&Value::Bool(true)) != rule.u.get("rav") {
            return Ok(());
        }
        let Some(variation) = lines(context).pop() else {
            return Ok(());
        };
        with_line(rule, context, |line| {
            annotate(line, "variations", variation)
        });
        Ok(())
    });
}

/// Run `f` on the line being built: the innermost on the stack, or, when
/// the stack is empty, the rule's node, which is a line when `game` or
/// `movetext` is the start rule. The database is never one.
fn with_line<R>(
    rule: &tabnas::Rule,
    context: &mut Context,
    f: impl FnOnce(&mut Value) -> R,
) -> Option<R> {
    if let Some(line) = lines(context).last_mut() {
        return Some(f(line));
    }
    let mut node = rule.node.borrow_mut();
    as_map(&node)?;
    Some(f(&mut node))
}

fn set_result(rule: &tabnas::Rule, context: &mut Context, marker: Option<String>) {
    let Some(marker) = marker else {
        return;
    };
    let Some(result) = GameResult::from_marker(&marker) else {
        return;
    };
    with_line(rule, context, |line| {
        if let Some(map) = as_map_mut(line) {
            map.value.insert("result".to_string(), to_value(&result));
        }
    });
}

/// The move a token carries: the matcher took the move apart once, and
/// the token's object is shared, so this costs a reference count. A token
/// with no object, which the matcher never makes, is taken apart from its
/// source.
fn move_of(san: &Regex, token: &tabnas::Token) -> Value {
    match &token.val {
        Value::Object(_) => token.val.clone(),
        _ => move_value(&decompose(san, token.src.as_str())),
    }
}

/// The tree's move: the token's fields, then its number and side, in a
/// map of its own, so the token's value stays as the passes showed it.
fn numbered(played: &Value, count: Count) -> Value {
    let Value::Object(stated) = played else {
        return played.clone();
    };
    let mut fields = IndexMap::with_capacity(stated.len() + 2);
    fields.extend(stated.iter().map(|(k, v)| (k.clone(), v.clone())));
    fields.insert("number".to_string(), Value::Number(count.number as f64));
    fields.insert("side".to_string(), text(count.side.as_str()));
    Value::object(fields)
}

fn text(value: &str) -> Value {
    Value::String(value.to_string())
}

/// A move as its token carries it: the fields its text states, in the
/// order the model serialises them, built straight into the engine's
/// value, since the matcher makes one for every move a document holds.
/// `the_values_are_the_models` holds it to `to_value`.
pub(crate) fn move_value(played: &Move) -> Value {
    let mut fields = IndexMap::with_capacity(9);
    fields.insert("san".to_string(), text(&played.san));
    let piece = match played.piece {
        Piece::P => "P",
        Piece::N => "N",
        Piece::B => "B",
        Piece::R => "R",
        Piece::Q => "Q",
        Piece::K => "K",
    };
    fields.insert("piece".to_string(), text(piece));
    if let Some(origin) = &played.disambiguation {
        let mut stated = IndexMap::with_capacity(2);
        if let Some(file) = &origin.file {
            stated.insert("file".to_string(), text(file));
        }
        if let Some(rank) = origin.rank {
            stated.insert("rank".to_string(), Value::Number(f64::from(rank)));
        }
        fields.insert("disambiguation".to_string(), Value::object(stated));
    }
    if played.capture {
        fields.insert("capture".to_string(), Value::Bool(true));
    }
    if let Some(to) = &played.to {
        fields.insert("to".to_string(), text(to));
    }
    if let Some(promotion) = played.promotion {
        let letter = match promotion {
            PromotionPiece::N => "N",
            PromotionPiece::B => "B",
            PromotionPiece::R => "R",
            PromotionPiece::Q => "Q",
        };
        fields.insert("promotion".to_string(), text(letter));
    }
    if let Some(castle) = played.castle {
        let side = match castle {
            CastleSide::King => "king",
            CastleSide::Queen => "queen",
        };
        fields.insert("castle".to_string(), text(side));
    }
    if let Some(check) = played.check {
        let mark = match check {
            CheckIndicator::Check => "+",
            CheckIndicator::Mate => "#",
        };
        fields.insert("check".to_string(), text(mark));
    }
    if let Some(annotation) = played.annotation {
        let suffix = match annotation {
            Annotation::Good => "!",
            Annotation::Poor => "?",
            Annotation::VeryGood => "!!",
            Annotation::VeryPoor => "??",
            Annotation::Speculative => "!?",
            Annotation::Questionable => "?!",
        };
        fields.insert("annotation".to_string(), text(suffix));
    }
    Value::object(fields)
}

/// A comment as its token carries it, built straight into the engine's
/// value; `the_values_are_the_models` holds it to `to_value`.
pub(crate) fn comment_value(comment: &Comment) -> Value {
    let mut fields = IndexMap::with_capacity(3);
    let kind = match comment.kind {
        CommentKind::Brace => "brace",
        CommentKind::Line => "line",
    };
    fields.insert("kind".to_string(), text(kind));
    fields.insert("text".to_string(), text(&comment.text));
    if !comment.commands.is_empty() {
        let commands = comment
            .commands
            .iter()
            .map(|command| {
                let mut entry = IndexMap::with_capacity(2);
                entry.insert("name".to_string(), text(&command.name));
                let args = command.args.iter().map(|arg| text(arg)).collect();
                entry.insert("args".to_string(), Value::array(args));
                Value::object(entry)
            })
            .collect();
        fields.insert("commands".to_string(), Value::array(commands));
    }
    Value::object(fields)
}

/// The token's value is the comment as the tree holds it, its commands
/// read as the `commands` option says, so the tree shares it; a token
/// with no object, which the matcher never makes, is read from its
/// source, its braces or its semicolon cut off, as the matcher cut them.
fn comment_action(rule: &tabnas::Rule, context: &mut Context, kind: CommentKind, commands: bool) {
    let Some(token) = rule.o0() else {
        return;
    };
    let comment = match &token.val {
        Value::Object(_) => token.val.clone(),
        _ => {
            let src = token.src.as_str();
            let text = match kind {
                CommentKind::Brace => src.get(1..src.len().saturating_sub(1)),
                CommentKind::Line => src.get(1..),
            };
            let Some(text) = text.map(str::to_string) else {
                return;
            };
            comment_value(&make_comment(kind, text, commands))
        }
    };
    with_line(rule, context, |line| annotate(line, "comments", comment));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::san::san_pattern;

    /// The values the matchers build are what serialising the model gives,
    /// field for field and in the same order, for every kind of move and
    /// comment.
    #[test]
    fn the_values_are_the_models() {
        let san = san_pattern(false);
        for src in [
            "e4", "exd5", "Nf3", "Nbd7", "N1f3", "Qh4xe1", "R1a3+", "Nbxd7+!", "O-O", "O-O-O#",
            "exd8=Q+", "e8=N??", "e8Q", "Ke2!?", "Bb5?!", "a1=R!!", "Pe4",
        ] {
            let played = decompose(&san, src);
            assert_eq!(move_value(&played), to_value(&played), "{src}");
            assert_eq!(
                move_value(&played).to_string(),
                to_value(&played).to_string(),
                "{src}"
            );
        }
        for (kind, text) in [
            (CommentKind::Brace, "a [%clk 0:01:00] [%cal Ge2e4,Rd7d5] b"),
            (CommentKind::Line, " plain"),
            (CommentKind::Brace, "[%emt]"),
        ] {
            for commands in [true, false] {
                let comment = make_comment(kind, text.to_string(), commands);
                assert_eq!(comment_value(&comment), to_value(&comment), "{text}");
                assert_eq!(
                    comment_value(&comment).to_string(),
                    to_value(&comment).to_string(),
                    "{text}"
                );
            }
        }
    }
}
