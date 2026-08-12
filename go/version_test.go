/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The Go `const VERSION` must equal ts/package.json "version".
//
// ts/test/version.test.ts checks the TypeScript export against the SAME
// file, so the two runtimes cannot drift apart either. There is no skip
// path: an unreadable package.json FAILS here, because a version check
// that silently does not run is the exact failure mode it exists to
// prevent.

package tabnaschess

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

func TestVersionMatchesPackageJSON(t *testing.T) {
	path := filepath.Join("..", "ts", "package.json")
	raw, err := os.ReadFile(path)
	if nil != err {
		t.Fatalf("cannot read %s, so VERSION cannot be checked: %v", path, err)
	}

	var pkg struct {
		Name    string `json:"name"`
		Version string `json:"version"`
	}
	if err := json.Unmarshal(raw, &pkg); nil != err {
		t.Fatalf("cannot parse %s: %v", path, err)
	}
	if "" == pkg.Version {
		t.Fatalf("%s has no version field, so VERSION cannot be checked", path)
	}

	if VERSION != pkg.Version {
		t.Fatalf("VERSION drift: %s exports %s but package.json is %s. "+
			"Both are rewritten at release; if you bumped one by hand, bump the other.",
			pkg.Name, VERSION, pkg.Version)
	}
}

func TestVersionIsSemver(t *testing.T) {
	if !regexp.MustCompile(`^\d+\.\d+\.\d+`).MatchString(VERSION) {
		t.Fatalf("VERSION %q must be a semver", VERSION)
	}
}
