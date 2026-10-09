# Stable extension context prefixes — 2026-10-09

## Defect and result

The `work-mode` context hook generated a runtime directive at the end of each
request, but Pi does not save a context transform's output in its ordinary
transcript. The next request therefore replaced the previous directive's position
with an assistant response or tool history. The old directive was absent, even
when its newly generated text was identical. Requirements anchors, PS reminders
and agent-message delivery used the same temporary-context mechanism.

The earlier cache acceptance checked only the initial request prefix and applied
the context hook only to its final request. It did not prove preservation of a
growing conversation's complete request prefix.

The fix records extension injections through `pi.appendEntry` and reconstructs
them at their original source-history boundaries. Runtime and requirements state
changes append new versions; unchanged state adds none. PS reminders can repeat
at new boundaries according to their existing selection policy. Clearing a
reminder appends an inactive notice instead of removing a historical message.
Agent-message batches remain in later requests after their delivery queue empties.

## Scope and integration

- `lib/stable-context.ts` owns the branch-local injection journal and
  projection. SHA-256 source-prefix fingerprints prevent replay after a history
  edit or compaction. Reading the current native SDK branch prevents abandoned
  branch records from leaking into the current branch. New session IDs reset the
  in-memory fallback, and journal records restore projections in a new manager.
- The four context hooks use this common projection, preserving injection order
  across separately loaded extensions. No system prompt or tool definition is
  rewritten by this change. Authorization continues through the existing tool
  permission guard.
- `scripts/verify-capability-cache.ts` now applies context hooks to every request,
  compares each complete preceding HTTP message prefix, includes a substantial
  synthetic tool history, and fails if reuse stalls at the initial prompt. Its
  `--provider` and `--model` flags select a test model without updating settings.

## Verification

**Local implementation: verified.**

- Strict typecheck passed.
- Targeted cache-prefix suite: 4 passing tests. The actual tolerant HTTP adapter
  was used with mocked fetch. Each request retained the preceding request's full
  message array through a tool call, tool result and authorization change. An
  unchanged repeated request had byte-identical JSON. No HTTP request was sent.
- Full `npm test`: 61 parallel-agent tests plus 156 remaining tests, **217 passing**.
  New native SDK journal regressions cover ordering across injection channels,
  inactive notices, branch changes, new sessions, restoration, compacted/edited
  source prefixes and repeated reminders.
- `git diff --check` passed.

The first full run passed the cache regressions but failed three existing
AUTO_FLASH settings tests because they tried to write the read-only global
settings file. Both data and settings directories were then isolated under `/tmp`,
and the full command passed:

```sh
env PI_AGENT_DATA_DIR=/tmp/pi-cache-fix-tests-0xDexe \
    PI_CODING_AGENT_DIR=/tmp/pi-cache-fix-tests-0xDexe npm test
```

No additional paid provider requests were made after the fix. The local request
preservation invariant is verified; post-fix upstream cache counters have not been
measured. The previously authorized six Luna diagnostic requests preceded this
patch and are not evidence of the repaired implementation's upstream hit rate.

Existing running Pi instances need extension reload to use the patched hooks.
Compaction, intentional history edits, model changes and upstream routing remain
independent cache boundaries.

## Audit

Completion checkpoint: 2026-10-09T07:16:28Z, Work / Guarded.
Effects: scoped workspace code/tests/manual-acceptance edits and this report;
isolated temporary test artifacts. Two static-check errors in the new helper were
repaired before the passing check. The read-only global-settings test failures
were resolved by changing the test environment. No commit, push, deployment or
user configuration update was performed.

## GitHub distribution verification — 7.1.2

The flat GitHub distribution passed its independent strict typecheck and all
221 tests: 61 parallel-agent, 155 work-mode/library/extension, and 5 stream-compat
tests. Its 96 production TypeScript files match the development checkout byte
for byte. Layout-specific test imports and scans were adapted without changing
production implementations. Development source commit: `fbe0d4551828ebaabc4a5554632cef863efa2e41`.

Both package and root lockfile identify version 7.1.2. Local work notes and user
configuration are excluded from the public synchronization. No paid model
requests were added during release validation.
