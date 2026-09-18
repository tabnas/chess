/* Copyright (c) 2026 Richard Rodger, MIT License */

//! The grammar actions: what each matched alternate does to the model.
//!
//! The grammar carries `@ref` strings and no functions, so it stays
//! shippable as data; the plugin binds these before installing it.
//!
//! # The node model in Rust
//!
//! A "line" is a game or a variation, and the two are the same shape:
//! `movetext` and `element` have no node of their own, so they inherit
//! the enclosing line and write into it. The engine gives every rule its
//! node as a shared `Rc<RefCell<Value>>`, so an inherited node is the
//! SAME cell — writing through it is what TypeScript gets from object
//! references. A rule that needs a node of its own (`pgn`, `game`, `rav`,
//! and `movetext` when it is the start rule) REPLACES the cell rather
//! than writing through it, or it would overwrite its parent's node.
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
use tabnas::{MapRef, Tabnas, Value};

use crate::commands::scan_commands;
use crate::model::{Comment, CommentKind, GameResult, Move, Side};
use crate::san::build_move;

// --- Node helpers --------------------------------------------------------

const COUNT_NUMBER: &str = "chess:number";
const COUNT_SIDE: &str = "chess:side";

/// The running `{number, side}` a line counts moves with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Count {
    number: u32,
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

fn to_value<T: Serialize>(item: &T) -> Value {
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
        Value::Number(number) => *number as u32,
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
    let field: Vec<&str> = fen.split_whitespace().collect();
    if Some(&"b") == field.get(1) {
        count.side = Side::Black;
    }
    if let Some(number) = field.get(5) {
        if !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit()) {
            if let Ok(number) = number.parse::<u32>() {
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
        Value::Number(number) => *number as u32,
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

fn make_comment(kind: CommentKind, text: String, parse: bool) -> Comment {
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
fn decompose(pattern: &Regex, src: &str) -> Move {
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

    // The database is a plain array. `gameitem` inherits this node, so
    // both rules write to the one cell.
    tn.state_action_ref("@pgn-bo", |rule, _context| {
        rule.node = Rc::new(RefCell::new(Value::array(Vec::new())));
        Ok(())
    });

    tn.state_action_ref("@gameitem-bc", |rule, _context| {
        let game = rule.child_node.clone();
        if game.is_undefined() || game.is_null() {
            return Ok(());
        }
        if let Some(database) = rule.node.borrow_mut().as_array_mut() {
            database.push(game);
        }
        Ok(())
    });

    tn.state_action_ref("@game-bo", |rule, _context| {
        rule.node = Rc::new(RefCell::new(new_game()));
        Ok(())
    });

    // `movetext` normally inherits the enclosing line and writes into it.
    // As a start rule it has no parent, so it allocates one.
    tn.state_action_ref("@movetext-bo", |rule, _context| {
        if rule.node.borrow().is_undefined() {
            rule.node = Rc::new(RefCell::new(new_line()));
        }
        Ok(())
    });

    // `r.node` is the game: `tag` and `tagbody` have no node of their own.
    tn.action_with_context("@tag", |rule, _context| {
        let Some(name) = rule.o0().map(|token| token.src.as_str().to_string()) else {
            return Ok(());
        };
        let Some(value) = rule.o1().and_then(|token| text_of(&token.val)) else {
            return Ok(());
        };
        let mut node = rule.node.borrow_mut();
        let Some(map) = as_map_mut(&mut node) else {
            return Ok(());
        };
        let Some(tags) = map
            .value
            .get_mut("tags")
            .and_then(|tags| tags.as_object_mut())
        else {
            return Ok(());
        };
        // PGN spec 8.1: a tag name should not repeat; the first wins, as a
        // reader has no better rule for choosing between them.
        if !tags.contains_key(&name) {
            tags.insert(name, Value::String(value));
        }
        Ok(())
    });

    tn.action_with_context("@result-open", |rule, _context| {
        let marker = rule.o0().map(|token| token.src.as_str().to_string());
        set_result(rule, marker);
        Ok(())
    });

    tn.action_with_context("@result-close", |rule, _context| {
        let marker = rule.c0().map(|token| token.src.as_str().to_string());
        set_result(rule, marker);
        Ok(())
    });

    // A `[` after the movetext has started belongs to the next game, not
    // to this one's tag section.
    tn.alt_condition("@more-tags", |rule, _context| {
        let node = rule.node.borrow();
        let Some(map) = as_map(&node) else {
            return true;
        };
        !has_moves(map) && !map.value.contains_key("result")
    });

    // PGN spec 8.2.6: the termination marker is the last element of a
    // movetext section, so movetext after one belongs to the next game.
    // This is what lets `*1. e4 *` be two games.
    tn.alt_condition("@no-result", |rule, _context| {
        let node = rule.node.borrow();
        as_map(&node).is_none_or(|map| !map.value.contains_key("result"))
    });

    let san = pattern.clone();
    tn.action_with_context("@move", move |rule, _context| {
        let Some(src) = rule.o0().map(|token| token.src.as_str().to_string()) else {
            return Ok(());
        };
        let mut node = rule.node.borrow_mut();
        let count = counter(&mut node);
        let mut played = decompose(&san, &src);
        played.number = Some(count.number);
        played.side = Some(count.side);
        set_count(
            &mut node,
            match count.side {
                Side::White => Count {
                    number: count.number,
                    side: Side::Black,
                },
                Side::Black => Count {
                    number: count.number + 1,
                    side: Side::White,
                },
            },
        );
        push_move(&mut node, to_value(&played));
        Ok(())
    });

    let san = pattern.clone();
    tn.action_with_context("@bare-move", move |rule, _context| {
        let Some(src) = rule.o0().map(|token| token.src.as_str().to_string()) else {
            return Ok(());
        };
        let played = to_value(&decompose(&san, &src));
        rule.node = Rc::new(RefCell::new(played));
        Ok(())
    });

    // PGN spec 8.2.2: the integer is the fullmove number of the move that
    // follows. Import format allows any number of periods, but three or
    // more is the export-format spelling for "Black to move", so it is
    // worth honouring where it appears.
    tn.action_with_context("@number", |rule, _context| {
        let Some(src) = rule.o0().map(|token| token.src.as_str().to_string()) else {
            return Ok(());
        };
        let digits: String = src.chars().take_while(char::is_ascii_digit).collect();
        let mut node = rule.node.borrow_mut();
        let mut count = counter(&mut node);
        if let Ok(number) = digits.parse::<u32>() {
            count.number = number;
        }
        match src.matches('.').count() {
            0 => {}
            1 => count.side = Side::White,
            _ => count.side = Side::Black,
        }
        set_count(&mut node, count);
        Ok(())
    });

    tn.action_with_context("@nag", |rule, _context| {
        let Some(src) = rule.o0().map(|token| token.src.as_str().to_string()) else {
            return Ok(());
        };
        let Ok(glyph) = src[1..].parse::<u32>() else {
            return Ok(());
        };
        annotate(
            &mut rule.node.borrow_mut(),
            "nags",
            Value::Number(glyph as f64),
        );
        Ok(())
    });

    tn.action_with_context("@brace-comment", move |rule, _context| {
        comment_action(rule, CommentKind::Brace, commands);
        Ok(())
    });

    tn.action_with_context("@line-comment", move |rule, _context| {
        comment_action(rule, CommentKind::Line, commands);
        Ok(())
    });

    // A variation replaces the move it follows, so it starts on that
    // move's number and side, not on the next one.
    tn.state_action_ref("@rav-bo", |rule, _context| {
        let count = match rule.parent_node.clone() {
            Some(parent) => {
                let mut parent = parent.borrow_mut();
                match last_move_count(&parent) {
                    Some(count) => count,
                    None => counter(&mut parent),
                }
            }
            None => Count::default(),
        };
        let mut line = new_line();
        set_count(&mut line, count);
        rule.node = Rc::new(RefCell::new(line));
        Ok(())
    });

    tn.state_action_ref("@element-bc", |rule, _context| {
        if Some(&Value::Bool(true)) != rule.u.get("rav") {
            return Ok(());
        }
        let variation = rule.child_node.clone();
        if variation.is_undefined() || variation.is_null() {
            return Ok(());
        }
        // A variation replaces the move it follows; one that follows no
        // move annotates the line's starting position instead.
        annotate(&mut rule.node.borrow_mut(), "variations", variation);
        Ok(())
    });
}

fn set_result(rule: &mut tabnas::Rule, marker: Option<String>) {
    let Some(marker) = marker else {
        return;
    };
    let Some(result) = GameResult::from_marker(&marker) else {
        return;
    };
    let mut node = rule.node.borrow_mut();
    if let Some(map) = as_map_mut(&mut node) {
        map.value.insert("result".to_string(), to_value(&result));
    }
}

fn comment_action(rule: &mut tabnas::Rule, kind: CommentKind, commands: bool) {
    let Some(text) = rule.o0().and_then(|token| text_of(&token.val)) else {
        return;
    };
    let comment = make_comment(kind, text, commands);
    annotate(&mut rule.node.borrow_mut(), "comments", to_value(&comment));
}
