.PHONY: all build test clean reset diagram

all: build test

build:
	npm run build

test:
	npm test

clean:
	rm -rf dist dist-test

reset:
	npm run reset

# Regenerate doc/grammar.{svg,txt} from the LIVE grammar, never by hand.
diagram: build
	node -e 'const {Tabnas}=require("@tabnas/parser"),{railroad}=require("@tabnas/railroad"),{Chess}=require("./dist/chess"),fs=require("fs");const tn=new Tabnas().use(Chess).use(railroad);fs.writeFileSync("doc/grammar.svg",tn.railroad.toSvg());fs.writeFileSync("doc/grammar.txt",tn.railroad.toAscii())'
