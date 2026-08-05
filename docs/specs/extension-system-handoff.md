# Extension system — session handoff

Written 2026-08-04, at a clean stopping point before a reboot, and updated after slice 9 — the last
slice — merged.
Everything described here is committed and pushed; there is no uncommitted or stashed work in either
checkout.

Read `extension-system.md` first — it is the durable spec, and its **slice status table** under
"Work breakdown" is the authoritative record of what is done. This file only covers what that spec
cannot: the state of branches and PRs, and the judgement calls that are not yet reflected in code.

## Where things stand

`develop` is at `aabef7b8` and **contains all ten extension slices**. Test baseline: **681 pass, 0
fail** (664 was the pre-slice-8 baseline). Lint has 19 pre-existing warnings and 0 errors — that is the clean
state, not a regression. Typecheck is clean across server, client, the SDK package and its
conformance project.

### Open PRs

| PR | Branch | State |
| --- | --- | --- |
| #13 | dependabot: typeorm 0.3.29 → 0.3.31 in `packages/extension-sdk` | Reviewed: **recommend closing rather than merging.** It bumps only the SDK's `devDependencies`. `typeorm` is a **peer** dependency there (`^0.3.29`), so this changes nothing about what an extension resolves at runtime — that is always the host's copy, still pinned to `0.3.29` in the root `package.json`. The dev copy exists precisely to typecheck the SDK against what the host ships, so moving it alone makes the conformance harness verify against a version no extension will ever see. Bump both together or neither. |
| #9 | `feat/media-removal-requests` → `develop` | Untouched, fully independent of the extension system. The user is undecided on wanting this feature at all. Do not merge on its behalf or build extension work on it. |

### Local branches, none of which need saving

- `develop` — synced with origin.
- `feat/extension-system` — 0 ahead of `develop`, fully merged. Safe to delete.
- `feat/extension-watch-history` — merged as PR #18 and deleted locally.
- `seerr.2` — the original working branch. 17 commits ahead by count, but everything extension-related
  has landed: 6 of the 7 commits `git cherry` flags are media-removal work, and the 7th
  (`672d8274`, the event bus) is only flagged because `develop` has the rebased version with the
  three `removal-request.*` events stripped. Verified: `git diff origin/develop seerr.2 --
  server/lib/extensions/events.ts server/subscriber/MediaSubscriber.ts` is **empty**. Nothing at risk.
- `feat/media-removal-requests` — PR #9's branch, in the `/Users/teagan/src/seerr` checkout.

Both the agent worktrees and their branches from this session have been removed.

## Remaining work

**All ten slices are merged.** The system as specced is done; nothing in the work breakdown is
outstanding. What follows is the follow-up list, not remaining slices — each is recorded in the
spec's open questions:

- **A dialect-portable column helper in the SDK.** An extension cannot declare a `datetime` that
  works on both sqlite and Postgres — it has no access to `DbAwareColumn` and no DataSource to ask
  at decoration time. Watch History works around it with `bigint` epoch millis. This is the one
  slice-9 finding that was documented rather than fixed.
- **Import-map ordering under `next dev`, with `basePath`/`assetPrefix`, and outside Chromium.** The
  browser verification below covers `next start` in Chromium only.
- **Silent React version coupling.** A panel built against React 18 gets 19 with no error; a
  manifest `requires.react` check is worth considering.
- **PR #13** (dependabot typeorm 0.3.29 → 0.3.31 in the SDK) is still unreviewed.

### Slice 6's browser gap is closed

This was the standing highest-value unverified item across two handoffs: no panel had ever mounted
in a real browser against the real `_app` tree, and the failure mode is quiet — a second React copy
renders its first output fine and dies on the first hook.

`cypress/e2e/extensions/panel.cy.ts` now does it, passing 4/4. It asserts on *hooks having run*
rather than markup: the panel's mount-time `sdk.api` fetch only fires if `useEffect` ran under the
host's React with the `sdk` prop intact.

Running it is manual, because an extension only takes effect at boot. The spec's header has the
sequence; two steps fail confusingly and are worth knowing before you hit them:

- **`WITH_MIGRATIONS=true pnpm cypress:prepare`.** The default seeds via `synchronize`, leaving
  `migrations` empty — extension migrations run through the same runner, so boot then attempts
  core's `InitialMigration` against existing tables and dies on `table "user" already exists`.
- **Enable the extension *after* preparing.** `cypress:prepare` overwrites `settings.json` wholesale
  from `cypress/config/settings.cypress.json`, which has no `extensions` key, so enabling first is
  silently undone and the spec skips itself.

The spec skipping itself when no panel is reported is a real limitation: a green `cypress run` on a
checkout with no extensions installed does **not** mean this ran.

### The duplicate Notification enum is gone

Slice 8 inherited a client copy of the enum that lagged the server's (8190 vs 16382). Rather than
adding the missing member — which would leave the same trap for the next notification type — the
duplicate was deleted. The enum now lives in an import-free `server/constants/notification.ts` that
both sides read; `server/lib/notifications` and `server/entity/UserSettings` re-export it, so no
importer changed. Same shape as `sharedModuleSpecifiers.ts` from slice 6, and the same reasoning:
make the drift unrepresentable instead of testing for it.

## Judgement calls worth not re-litigating

These were decided deliberately, and each contradicts something an unaided reader would reasonably
assume. The spec now records all of them, but the reasoning is worth having in one place.

**The `EXTENSION` sentinel is bit 13 (`8192`) and must never be renumbered.** It is persisted in
every user's saved notification mask. An earlier draft of the spec said bit 17, counting from
`MEDIA_REMOVAL_AUTO_APPROVED` — that member only exists on the media-removal branch, which is not
part of this work. A branch that adds its own notification types will want a different value; that is
a real merge hazard, not a formality.

**Uninstall retains permission and subscription rows by default.** The spec originally asked for "no
orphaned permission rows," which contradicted slice 4's decision that a quarantined extension's grants
stay on disk so restoring it restores them. Tables and `ext_kv` rows are always dropped (their shape
came from entity classes that leave with the directory); `ext_permission` and
`ext_notification_subscription` rows are the *operator's* decisions about users and are string-keyed
precisely so they can outlive the code. `purgeData: true` is the opt-in to forget them.

**Install fetching is restricted on both the npm and git paths, and only the git half was there
originally.** `sourceKind` routes only recognizable git remotes to git; everything else goes to npm,
and npm accepts `file:` specifiers, bare paths and `github:`-style shorthands as package sources. So
the git command's scheme allowlist — which is what the code documented — never saw the inputs it named.
The npm side now allowlists the registry name shape plus a local `.tgz`. **This is not a privilege
boundary**: installing is an ADMIN action and extensions are trusted, `require()`d in-process, so an
admin who can install can already run code. The bug was a documented defense that did not exist.

**`defineExtension` removes undeclared SDK members from the type rather than leaving them optional**,
so a forgotten manifest `requires` is a compile error instead of a `sdk.users?.get()` that silently
never runs. This only works on a literal manifest, and the set of ways to get one is narrower than it looks:
`const m: ExtensionManifest = {…}` erases the literals, and **importing the JSON widens them** —
`resolveJsonModule` turns `true` into `boolean`, so nothing narrows and nothing errors. Slice 9
found this; the README and conformance example now use `as const satisfies`, and the cost is that a
manifest exists twice with a drift test between the copies.

**SDK entity types are re-declared structurally, not re-exported.** Seerr is unpublished, so there is
nothing to peer-depend on, and shipping generated `.d.ts` would drag in the whole entity graph.
`packages/extension-sdk/conformance/hostContract.ts` compiles the stand-ins against the real
`server/lib/extensions/types.ts`, so drift fails a typecheck rather than a runtime call.

## Gotchas that cost time in this session

- **Run lint with the project's globs**, not `eslint .`. `pnpm lint` scopes to `server/`, `src/` and
  `packages/*`; a bare `eslint .` picks up `tailwind.config.js` and reports 7 spurious errors.
- **Agent worktrees have no `node_modules`.** `pnpm typecheck`/`lint`/`format` fail there with
  `tsc: command not found`. Run the main checkout's binaries directly
  (`/Users/teagan/src/seerr/node_modules/.bin/{tsc,eslint,prettier}`). `pnpm test` works regardless,
  because the runner resolves differently.
- **The test runner takes file arguments**: `node server/test/index.mts server/lib/extensions/x.test.ts`
  runs one file in ~15s instead of the full ~3.5min suite.
- **A "failed" force-push may mean the branch was deleted by a merge.** `--force-with-lease` reports
  stale info and a subsequent fetch says `couldn't find remote ref`. Check `gh pr view` before
  assuming the push failed.
- `.husky/prepare-commit-msg: /dev/tty: Device not configured` prints on every commit in this
  environment. Harmless; the commit succeeds.
