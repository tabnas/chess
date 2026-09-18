# Build and test the TypeScript (ts/), Go (go/) and Rust (rs/)
# implementations. ts/ is canonical; the other two track it.
#
# The grammar is single-sourced in chess-grammar.jsonic and embedded into
# ALL THREE of ts/src/chess.ts, go/chess.go and rs/src/lib.rs by
# ts/embed-grammar.js, which `npm run build` runs first. Build the TS side
# before the others after a grammar change, or they compile against a
# stale copy.

# Serial, always. `build-ts` runs ts/embed-grammar.js, which REWRITES the
# embedded grammar inside go/chess.go and rs/src/lib.rs, and `build-web`
# bundles what `build-ts` compiled. Under `make -j` those writes race the
# reads, so the ordering the aggregate targets spell out has to be the
# ordering make uses.
.NOTPARALLEL:

.PHONY: all build test clean reset diagram \
        build-ts build-go build-rs build-web test-ts test-go test-rs test-web \
        clean-ts clean-go clean-rs clean-web publish-ts publish-go tags-go tidy-go \
        prose prose-counts

all: build test

build: build-ts build-go build-rs build-web

test: test-ts test-go test-rs test-web

clean: clean-ts clean-go clean-rs clean-web

# --- TypeScript (package in ts/) ---
build-ts:
	cd ts && npm run build

test-ts:
	cd ts && npm test

clean-ts:
	rm -rf ts/dist ts/dist-test

# Publish the TypeScript package at its current package.json version.
publish-ts: test-ts
	cd ts && npm publish --access public

# --- Web component (package in web/) ---
# Bundles the TypeScript package, so build-ts has to have run first.
build-web: build-ts
	cd web && npm run build

test-web: build-web
	cd web && npm test

clean-web:
	rm -rf web/dist

# --- Go (module in go/) ---
build-go:
	cd go && go build ./...

test-go:
	cd go && go test ./...

clean-go:
	cd go && go clean

tidy-go:
	cd go && go mod tidy

# --- Rust (crate in rs/) ---
# Depends on a sibling checkout of tabnas/parser for the engine crate,
# which is not published to crates.io. See rs/README.md.
build-rs:
	cd rs && cargo build --all-targets

test-rs:
	cd rs && cargo test --all-targets
	cd rs && cargo test --doc
	cd rs && cargo clippy --all-targets --all-features -- -D warnings
	cd rs && cargo fmt --all --check

clean-rs:
	cd rs && cargo clean

# Publish the Go module: make publish-go V=x.y.z
# Injects V into the Go `VERSION` const, commits, and tags go/vX.Y.Z.
publish-go: test-go
	@test -n "$(V)" || (echo "Usage: make publish-go V=x.y.z" && exit 1)
	sed -i.bak 's/^const VERSION = ".*"/const VERSION = "$(V)"/' go/chess.go
	rm -f go/chess.go.bak
	git add go/chess.go
	git commit -m "go: v$(V)"
	git tag go/v$(V)
	git push origin main go/v$(V)

# List published Go module tags, newest first.
tags-go:
	git tag -l 'go/v*' --sort=-version:refname

# Regenerate the railroad diagram from the live grammar.
diagram:
	cd ts && $(MAKE) diagram

reset:
	cd ts && npm run reset
	cd go && go clean -cache && go build ./... && go test ./...
	cd rs && cargo clean && cargo build --all-targets && cargo test --all-targets

# The prose gate (see docs/STYLE-GUIDE.md). Vale over the reader-facing
# pages, at the levels set in .vale.ini, on the same file list
# ts/test/docs.test.js reads. Requires `vale` on PATH and one
# `vale sync`. Warnings are advisory, errors fail.
prose:
	vale --minAlertLevel=error $$(node ts/scripts/gated-docs.cjs)
	node ts/scripts/vale-counts.cjs

# Re-measure what .vale.ini and the style guide record, after
# a change to the pages or to the rules moves the numbers.
prose-counts:
	node ts/scripts/vale-counts.cjs --write
