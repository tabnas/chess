# Build and test the TypeScript implementation in ts/.
#
# The grammar is single-sourced in chess-grammar.jsonic and embedded into
# ts/src/chess.ts by ts/embed-grammar.js, which `npm run build` runs first.

.PHONY: all build test clean reset diagram publish-ts

all: build test

build:
	cd ts && npm run build

test:
	cd ts && npm test

clean:
	rm -rf ts/dist ts/dist-test

reset:
	cd ts && npm run reset

# Regenerate the railroad diagram from the live grammar.
diagram:
	cd ts && $(MAKE) diagram

# Publish the TypeScript package at its current package.json version.
publish-ts: test
	cd ts && npm publish --access public
