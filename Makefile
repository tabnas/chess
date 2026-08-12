# Build and test both the TypeScript (ts/) and Go (go/) implementations.
# ts/ is canonical; go/ tracks it.
#
# The grammar is single-sourced in chess-grammar.jsonic and embedded into
# BOTH ts/src/chess.ts and go/chess.go by ts/embed-grammar.js, which
# `npm run build` runs first. Build the TS side before the Go side after a
# grammar change, or Go will compile against a stale copy.

.PHONY: all build test clean reset diagram \
        build-ts build-go build-web test-ts test-go test-web \
        clean-ts clean-go clean-web publish-ts publish-go tags-go tidy-go

all: build test

build: build-ts build-go build-web

test: test-ts test-go test-web

clean: clean-ts clean-go clean-web

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
