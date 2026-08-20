# Agent guide for rootstock

## What this repo is

Rootstock is one interface over "some code-editing agent," with drivers behind it, so that
trellis can swap engines without a rewrite.

Rootstock knows nothing about trellis. There are no workspaces here, no previews, no deploy
gates, no editor concepts of any kind. It is a library plus a driver registry, and anything
that wants to drive a coding agent programmatically can use it. If a change would only make
sense to trellis, it belongs in trellis.

Design of record: `docs/trellis-editor-architecture.md` §2.5, in the `is4co/adaptig` repo.

## Toolchain

**bun, never npm or yarn.** There is one lockfile, `bun.lock`; a `package-lock.json` or
`yarn.lock` appearing here is a mistake to delete, not to merge.

The gates are:

```sh
bun run check    # lint + typecheck
bun run build    # declaration emit to dist/
bun test
```

Run all three before every commit, and **never path-scoped** — the whole point of a gate is
that it sees the files you did not think to look at. `dist/` is a compile gate, not the
distribution artifact: consumers install this package by git tag and execute the TypeScript
source directly, so `exports`, `module` and `types` all point at `src/`, and they stay that
way.

## The public contract

`src/types.ts` is the published interface. Trellis pins this repo by git tag, so **changing
an exported type is a breaking change** — deliberate, called out in the commit message, and
paired with whatever tag bump it implies. Adding to the interface is cheap; changing the
shape of something already exported is not.

## Drivers translate; they never pass their native events through

The `AgentEvent` union in `src/types.ts` is the whole vocabulary the outside world sees. A
driver's job is to turn its engine's stream into that union — not to widen the union so its
engine fits, and not to leak an engine-shaped payload through `tool.other` because mapping it
properly was harder. An event a driver genuinely cannot map stays opaque and collapsible, so
an unknown engine degrades to "working" instead of to silence.

Every driver declares its capabilities, and every declared degradation is a promise about
behavior. The conformance suite in `src/conformance/` grades both. It is the entry test for
any new driver: a driver that does not pass it is not finished.

## Model tiers are surfaced by name only

Haiku, Sonnet, Opus. Never version numbers, and no Fable-class tier. The mapping from a tier
to a concrete model version lives inside a driver, where it can change when the vendor
changes it, and never in the types (architecture §9, decision 9). An owner picking a tier is
picking cost and depth, not a release.

## Working here

**Commit and push without asking.** Finishing a piece of work means it is committed and
pushed in the same turn — not left in the working tree for someone to find. That permission
is standing.
