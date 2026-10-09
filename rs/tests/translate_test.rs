/* Copyright (c) 2026 Richard Rodger, MIT License */

//! The translation parts: what the manifest says and what the crate
//! embeds are the same files.
//!
//! A packaged crate holds nothing outside `rs/`, so the crate embeds its
//! own copies, `rs/translate/manifest.json` of `tabnas.plugin.json` and
//! `rs/translate/render.alc` of the render the manifest names, and
//! `translate()` hands them to a host. The copies are the only texts a
//! host sees, so they must be the files: this holds the embedded manifest
//! to the repository's, and the render the manifest names, read from the
//! repository, to the embedded one, as it would an embed the manifest
//! named. Change the file at the root and run `npm run embed` in `ts/`,
//! which copies it into `rs/translate/`; this fails until both are the
//! same.

use std::fs;
use std::path::PathBuf;

use serde_json::Value;

fn repo_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn read(path: &str) -> String {
    let file = repo_dir().join(path);
    fs::read_to_string(&file).unwrap_or_else(|e| panic!("cannot read {}: {e}", file.display()))
}

fn manifest() -> Value {
    serde_json::from_str(&read("tabnas.plugin.json")).expect("the manifest is JSON")
}

/// The manifest's `translate` object.
fn translate_object() -> Value {
    manifest()
        .get("translate")
        .cloned()
        .expect("the manifest carries a translate object")
}

#[test]
fn the_manifest_the_crate_embeds_is_the_repositorys() {
    let parts = tabnas_chess::translate().expect("PGN carries translation parts");
    assert_eq!(
        parts.manifest,
        read("tabnas.plugin.json"),
        "rs/translate/manifest.json is not tabnas.plugin.json: run npm run embed in ts"
    );
}

#[test]
fn the_render_the_manifest_names_is_the_one_the_crate_embeds() {
    let translate = translate_object();
    let path = translate["render"]
        .as_str()
        .expect("translate.render names a file");
    let parts = tabnas_chess::translate().expect("PGN carries translation parts");
    let render = parts.render.expect("PGN carries a render");
    assert_eq!(render.entry, "pgn-render");
    assert_eq!(
        render.source,
        Some(read(path).as_str()),
        "translate.render names {path}, and the crate embeds another text: run npm run embed in ts"
    );
}

/// An embed takes a plain tree into a format's own schema. PGN's tree is
/// the reader's database of games, and a plain tree has no PGN form, so
/// its manifest names none and the crate carries none; a manifest that
/// named one would be held to its file here, as the render is above.
#[test]
fn the_embed_the_manifest_names_is_the_one_the_crate_embeds() {
    let translate = translate_object();
    let parts = tabnas_chess::translate().expect("PGN carries translation parts");
    let Some(path) = translate.get("embed").and_then(Value::as_str) else {
        assert_eq!(
            parts.embed, None,
            "the manifest names no embed, and the crate carries one"
        );
        return;
    };
    let embed = parts
        .embed
        .unwrap_or_else(|| panic!("translate.embed names {path}, and the crate carries no embed"));
    assert_eq!(embed.entry, "pgn-embed");
    assert_eq!(
        embed.source,
        Some(read(path).as_str()),
        "translate.embed names {path}, and the crate embeds another text: run npm run embed in ts"
    );
}

/// PGN is read as a tree and written from one, and the tree is the
/// reader's own: the schema names it, its root is the database, an array
/// of games, and there is no lift, since the events carry the tree
/// already.
#[test]
fn pgn_reads_and_writes_its_own_tree() {
    assert_eq!(manifest()["languageId"], "pgn");
    let translate = translate_object();
    assert_eq!(translate["reads"], "tree");
    assert_eq!(translate["writes"], "tree");
    assert_eq!(translate["root"], "array");
    assert_eq!(translate["schema"], "pgn-database");
    assert_eq!(translate.get("lift"), None);
    let parts = tabnas_chess::translate().expect("PGN carries translation parts");
    assert_eq!(parts.lift, None);
}

/// The host prints the loss lines verbatim, so each is a sentence.
#[test]
fn the_loss_is_a_list_of_sentences() {
    let translate = translate_object();
    let loss = translate["loss"]
        .as_array()
        .expect("translate.loss is a list");
    assert!(!loss.is_empty());
    for line in loss {
        let line = line.as_str().expect("each loss line is a string");
        assert!(
            line.starts_with(char::is_uppercase) && line.ends_with('.'),
            "{line:?} is not a sentence"
        );
    }
}

/// A host links the render with its own program and other formats'
/// parts, so every definition is named for PGN, the entry point is
/// `pgn-render`, and the file defines no `export` of its own.
#[test]
fn the_render_is_a_library_named_for_pgn() {
    let render = tabnas_chess::translate()
        .and_then(|parts| parts.render)
        .and_then(|render| render.source)
        .expect("PGN carries the render's text");
    let names: Vec<&str> = render
        .lines()
        .filter_map(|line| line.strip_prefix("def "))
        .filter_map(|rest| rest.split_whitespace().next())
        .collect();
    assert!(names.contains(&"pgn-render"), "{names:?}");
    for name in &names {
        assert!(name.starts_with("pgn-"), "{name} is not named for PGN");
    }
}
