# Extension system — session handoff

Written 2026-08-05, at a clean stopping point before a reboot. Everything described here is
committed and pushed; there is no uncommitted or stashed work in either checkout.

Read `extension-system.md` first — it is the durable spec, and its **slice status table** under
"Work breakdown" is the authoritative record of what is done. This file only covers what that spec
cannot: the state of branches and PRs, and the judgement calls that are not yet reflected in code.

## Where things stand

`develop` is at `ab9509d0`, which includes extension slices 1–5, 7 and 10. Test baseline on
`develop`: **641 pass, 0 fail**. Lint has 19 pre-existing warnings and 0 errors — that is the clean
state, not a regression. Typecheck is clean across server, client, the SDK package and its
conformance project.

### Open PRs

| PR | Branch | State |
| --- | --- | --- |
| #14 | `docs/extension-slice-status` → `develop` | Docs only, mergeable. Adds the slice status table and promotes the panels spike into `docs/specs/spike-panels/`. **Needs merging** — it is the tail of #11/#12 and landed after they were merged, so `develop` does not yet have it. |
| #13 | dependabot: typeorm 0.3.29 → 0.3.31 in `packages/extension-sdk` | Not reviewed. Note `typeorm` is a **peer** dependency of the SDK; bumping the dev copy there does not change what extensions resolve at runtime, which is the host's copy. |
| #9 | `feat/media-removal-requests` → `develop` | Untouched, fully independent of the extension system. The user is undecided on wanting this feature at all. Do not merge on its behalf or build extension work on it. |

### Local branches, none of which need saving

- `develop` — synced with origin.
- `docs/extension-slice-status` — pushed, is PR #14.
- `feat/extension-system` — 0 ahead of `develop`, fully merged. Safe to delete.
- `seerr.2` — the original working branch. 17 commits ahead by count, but everything extension-related
  has landed: 6 of the 7 commits `git cherry` flags are media-removal work, and the 7th
  (`672d8274`, the event bus) is only flagged because `develop` has the rebased version with the
  three `removal-request.*` events stripped. Verified: `git diff origin/develop seerr.2 --
  server/lib/extensions/events.ts server/subscriber/MediaSubscriber.ts` is **empty**. Nothing at risk.
- `feat/media-removal-requests` — PR #9's branch, in the `/Users/teagan/src/seerr` checkout.

Both the agent worktrees and their branches from this session have been removed.

## Remaining work

Slices 6, 8 and 9, per the spec's status table. **Slices 6 and 8 both edit `src/`, so do not run them
concurrently** — two agents in the same client files collided earlier in this work and it cost a
rebase.

Suggested order: 6 → 8 → 9. Slice 9 (Watch History) is the real test of whether the SDK is adequate,
so expect it to force revisions to 6 and 8; doing it last is deliberate.

### Slice 6 is the next thing, and it is not starting from zero

The shared-React question is **answered and verified in a browser**. The prototype is at
`docs/specs/spike-panels/` — start from it rather than re-deriving. Its README records the four facts
that drove the design and, importantly, what the spike did *not* cover.

The first job is the one thing the spike never did: render a panel inside Seerr's **real** `_app`
tree (Layout, `SWRConfig`, `IntlProvider`), not a standalone harness. Everything else is lower risk.

Also required for slice 6, and easy to miss because it is recorded as an open question rather than in
the slice list: **a self-service effective-permissions endpoint**. Slice 4 shipped
`GET /user/:id/settings/extension-permissions`, but it is `MANAGE_USERS`-gated and keyed by *another*
user's id, so a signed-in user cannot learn their own extension permissions — which is exactly what
panel gating needs. The client's `hasPermission` is synchronous and bitmask-only; extension
permissions are async DB rows.

### Slice 8 inherits a known bug

`src/components/NotificationTypeSelector/index.tsx` duplicates the `Notification` enum and computes
its own `ALL_NOTIFICATIONS`, which now lags the server's (8190 vs 16382) because the server gained
the `EXTENSION` sentinel.

This is **not** data loss: toggling is per-bit additive (`currentTypes ± option.value`), so unknown
bits survive an edit. The actual exposure is narrower — `UserNotificationsEmail.tsx:64` and
`UserNotificationsWebPush/index.tsx:252` fall back to the client constant when the server returns no
saved value, so a user who has *never* saved notification settings gets the extension bit off. Slice 8
owns this UI and should add the sentinel client-side.

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
never runs. This only works on a literal manifest — `const m: ExtensionManifest = {…}` erases the
literals — so authors must inline it, use `satisfies`, or import the JSON.

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
