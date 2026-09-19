/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

//! `VERSION`, the crate version and `ts/package.json` "version" must all
//! agree.
//!
//! `ts/test/version.test.ts` and `go/version_test.go` check their own
//! runtimes against the SAME file, so none of the three can drift apart.
//! There is no skip path: an unreadable package.json FAILS here, because
//! a version check that silently does not run is the exact failure mode
//! it exists to prevent.

use std::fs;
use std::path::Path;

use tabnas_chess::VERSION;

#[test]
fn version_matches_cargo_toml() {
    assert_eq!(
        env!("CARGO_PKG_VERSION"),
        VERSION,
        "VERSION drift inside the crate: Cargo.toml and lib.rs disagree"
    );
}

#[test]
fn version_matches_package_json() {
    let path = Path::new("..").join("ts").join("package.json");
    let raw = fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!(
            "cannot read {}, so VERSION cannot be checked: {error}",
            path.display()
        )
    });
    let package: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|error| panic!("cannot parse {}: {error}", path.display()));
    let version = package["version"].as_str().unwrap_or_else(|| {
        panic!(
            "{} has no version field, so VERSION cannot be checked",
            path.display()
        )
    });

    assert_eq!(
        version,
        VERSION,
        "VERSION drift: {} exports {VERSION} but package.json is {version}. \
         All three are rewritten at release; if you bumped one by hand, bump the others.",
        package["name"].as_str().unwrap_or("this package")
    );
}

#[test]
fn version_is_semver() {
    let mut field = VERSION.split('.');
    for part in 0..3 {
        let value = field.next().unwrap_or("");
        assert!(
            !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()),
            "VERSION {VERSION:?} must be a semver (field {part} is {value:?})"
        );
    }
}
