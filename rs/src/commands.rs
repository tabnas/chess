/* Copyright (c) 2026 Richard Rodger, MIT License */

//! `[%name operand,operand]` markup inside a comment.
//!
//! From the *PGN Specification Supplement* (final draft, 8 September
//! 2001), not the 1994 standard. This parses the syntax and interprets
//! none of the command names.

use std::sync::OnceLock;

use regex::Regex;

use crate::model::Command;

/// The OPENING of a command. Only the opening: where a command ENDS
/// cannot be written as a regular expression — see [`scan_commands`].
fn command_open() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\[%([A-Za-z_][A-Za-z0-9_]*)").expect("literal"))
}

/// JavaScript's whitespace class, which is what the canonical plugin
/// splits and trims with (`/\s+/`, `String.prototype.trim`). It is not
/// Rust's `char::is_whitespace`: U+FEFF is whitespace only to JavaScript,
/// and U+0085 only to Rust. Every other character the two classes agree
/// on.
pub(crate) fn js_space(character: char) -> bool {
    '\u{FEFF}' == character || (character.is_whitespace() && '\u{85}' != character)
}

fn space(text: &[u8], mut at: usize) -> usize {
    while at < text.len() && (b' ' == text[at] || b'\t' == text[at]) {
        at += 1;
    }
    at
}

/// Find every `[%name operand,operand]` command in a comment body,
/// returning the commands and their byte spans in `text`.
///
/// A scanner rather than a regular expression, because the supplement
/// puts the terminator inside the operand grammar: an operand is either
/// bare — any ASCII but a comma or a right bracket — or a double-quoted
/// string, which may contain both. So in
///
/// ```text
/// [%src "Lasker, Common Sense in Chess (1896), p. 12]"]
/// ```
///
/// the command ends at the last bracket and holds one operand, not two.
/// `[^\]]*` would stop at the first bracket and split the citation at its
/// comma; no regular expression can do better, because matching quotes is
/// not something a regular language can express.
///
/// Anything that does not close is not a command: it stays in the text as
/// the prose it is. The supplement is explicit that a reader which does
/// not understand a command passes it through untouched, and the same
/// courtesy is owed to something that only looks like one.
///
/// Byte offsets are sound because every delimiter is ASCII, so a span
/// never lands inside a multi-byte character.
pub(crate) fn scan_commands(text: &str) -> (Vec<Command>, Vec<(usize, usize)>) {
    let mut commands = Vec::new();
    let mut spans = Vec::new();
    let bytes = text.as_bytes();
    let mut from = 0;

    while from < text.len() {
        let Some(open) = command_open().captures_at(text, from) else {
            break;
        };
        let whole = open.get(0).expect("group 0 always matches");
        let start = whole.start();
        let name = open.get(1).expect("the name is not optional").as_str();
        let mut at = whole.end();
        let mut args: Vec<String> = Vec::new();

        // The name is terminated by the first space — or by the bracket,
        // for a command with no operands at all.
        if at < bytes.len() && (b' ' == bytes[at] || b'\t' == bytes[at]) {
            at = space(bytes, at);

            loop {
                if at < bytes.len() && b'"' == bytes[at] {
                    let Some(close) = text[at + 1..].find('"') else {
                        break; // unterminated: not a command
                    };
                    args.push(text[at + 1..at + 1 + close].to_string());
                    at = space(bytes, at + close + 2);
                } else {
                    let mut end = at;
                    while end < bytes.len() && b',' != bytes[end] && b']' != bytes[end] {
                        end += 1;
                    }
                    // `a,,b` and a trailing comma contribute nothing.
                    let bare = text[at..end].trim_matches(js_space);
                    if !bare.is_empty() {
                        args.push(bare.to_string());
                    }
                    at = end;
                }

                if at < bytes.len() && b',' == bytes[at] {
                    at = space(bytes, at + 1);
                    continue;
                }
                break;
            }
        }

        if at >= bytes.len() || b']' != bytes[at] {
            from = start + 2; // never closed: leave it as prose
            continue;
        }
        at += 1;

        commands.push(Command {
            name: name.to_string(),
            args,
        });
        spans.push((start, at));
        from = at;
    }

    (commands, spans)
}

fn collapse_spaces() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[ \t]+").expect("literal"))
}

/// Remove `[%name ...]` markup from a comment body and tidy the result.
///
/// The supplement asks presentation software to "strip out all commands
/// before display in order to improve legibility" — without it, a lichess
/// export reads `{ [%clk 0:03:00] }` where the annotator's prose should
/// be.
pub fn strip_commands(text: &str) -> String {
    let (_, spans) = scan_commands(text);
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    for (start, end) in spans {
        out.push_str(&text[at..start]);
        out.push(' ');
        at = end;
    }
    out.push_str(&text[at..]);
    collapse_spaces()
        .replace_all(&out, " ")
        .trim_matches(js_space)
        .to_string()
}
