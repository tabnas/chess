# Divergences — @tabnas/chess

Differences between the TypeScript and Go ports that are **recorded rather
than repaired**, each pinned in both ports so the record cannot outlive
what it records (admin `DECISIONS.md` ADR-14).

A pin here fails when the divergence is REPAIRED, not only when it
regresses. That is deliberate: it is the signal to delete the entry along
with the pins.

## The two ports reject non-notation input at different tokens

**Not repaired** — which port is right needs a decision about where this
grammar draws the line between "a move" and "not chess notation", and
that is a language question, not a porting slip.

Measured on `[a b]`. Both ports reject it, with the same code:

| | position | message |
| --- | --- | --- |
| TypeScript | **1:4** | fails on `b` |
| Go | **1:2** | `not chess notation: a` |

The columns differ because the ports fail at **different tokens**.
TypeScript gets past `a` and stops at `b`; Go stops at `a`. So this is not
a column-arithmetic difference of the kind `parser/DIVERGENCE.md` records
for astral characters — the two ports disagree about which input is the
first thing they cannot accept.

### How it was found

`tasks/ax-parity-probe` in `tabnas/admin`, once this repo gained the
`pluginKind: "grammar"` descriptor field in the same change that adds this
file, and once that probe learned to drive a **raw-engine** grammar —
`new Tabnas().use(Chess)`, no jsonic layer, which is this repo's
construction and was not one the probe could build.

Worth recording how close it came to being missed. Before the probe could
reach this repo, the same 23 inputs were run through both ports **by
hand** and reported no divergence. That comparison canonicalised parsed
VALUES and never looked at error positions; both ports reject `[a b]`, so
it saw agreement. A hand check is only as wide as what the checker thought
to compare.
