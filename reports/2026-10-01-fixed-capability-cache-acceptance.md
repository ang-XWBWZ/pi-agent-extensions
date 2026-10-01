# Fixed capability transport and cache acceptance — 2026-10-01

## Objective and scope

Loading a capability must leave request-level native tool definitions and the
existing system/history prefix unchanged. Guides and operation schemas belong in
load tool results. Capability operations execute through a fixed gateway, with
normal phase, authorization, protected-path, schema and child-tool checks.

Provider, model, credential and user configuration were preserved during
implementation and verification. Existing development `.workbuddy/` content
was preserved and was not included in the distribution.

## Implementation

- `capability-dispatch.ts` retains operation implementations in a session-local
  registry. Only fixed baseline tools are registered with the SDK. This matters
  because SDK `refreshTools` automatically enables newly registered native tools.
- `load_capability` returns operation schemas and usage guides without mounting
  tools. The capabilities section is no longer inserted into the system prompt.
- `call_capability` uses native argument validation and sends the resolved operation
  and validated arguments through the existing permission guard. Execution needs
  a one-shot approval bound to the session, call ID and exact arguments.
- Pi loads extensions with `jiti moduleCache=false`; registry containers are
  shared across module copies, while operation closures, pending approvals and
  tool ceilings remain session-local. A real SDK loader regression verifies
  cross-extension loading, permission review and execution.
  Children retain logical operation ceilings independently of the fixed native
  loadout. Child panel updates use the gateway.
- Runtime initialization preserves its registered session ID. An explicit missing
  scope receives a guarded fallback rather than retaining an outer ALS scope.
- MCP discovery and aliases remain internal; reserved native names cannot be
  registered by the MCP capture path.

## Usage-statistics defect found during live acceptance

The initial normalized usage reported zero cache-read tokens. Inspection of raw
SSE usage proved cache hits were present: the active tolerant stream stopped at
`finish_reason`, discarding usage-only frames that followed it. The active
`stream-compat` tolerant implementation now processes buffered frames and allows
up to one second for requested usage to arrive. `[DONE]`, EOF, usage completion
and cancellation still terminate reading. A missing usage frame does not hold a
finished request indefinitely.

A diagnostic run also contained one upstream usage sample with no cached-token
field; the strict acceptance script rejected that run. The final full run below
passed all samples. This is evidence of cache reuse for the tested requests, not
an assertion that an upstream service always retains or reports its cache.

## Verification

- `npm test`: strict typecheck passed; parallel-agent 61 and remaining tests 148,
  **209 passing tests** in total.
- Separate existing stream-compat suite: **5 passing tests**.
- New regressions cover fixed native definitions, actual adapter payload prefix
  identity, loading and repeat loading, dynamic registration, phase changes,
  schema validation, protected paths even in Auto All, child ceilings, exact
  one-shot approvals, session isolation, trailing SSE usage split across chunks,
  bounded completion without usage/EOF, and cancellation during the grace period.
- The manual acceptance script is included in strict typechecking. It fails if
  request prefixes differ or later samples report less than 80% reuse of the
  initial input. It uses only synthetic data, inspects raw HTTP payloads and
  numeric usage counters, and does not print credentials or response content.

## Final live acceptance

Configured provider/model: `gptplus-openai / gpt-6.1-sol`.
The probe used the repository's actual fixed baseline definitions, actual load
implementation, `/plan` command and context directive, and the configured
provider's streaming implementation. Local load calls were represented as
synthetic assistant/tool-result turns; the probe does not depend on the model
choosing to call load itself. The gateway's local execution is covered separately
by permission integration tests.

| Request | Total input tokens | Cache-read tokens | Uncached input | Cache-read fraction |
|---|---:|---:|---:|---:|
| initial | 5564 | 5376 | 188 | 96.62% |
| warm | 5564 | 5376 | 188 | 96.62% |
| after_load | 5728 | 5632 | 96 | 98.32% |
| repeat_load_and_plan | 6007 | 5760 | 247 | 95.89% |

Every request had the same hash for tools, system/instructions and the original
message prefix:

`ce310e1eb8f93b31d8e21e7fb6038f245eb35bb546c4becf908517d04c1492e3`

Normalized cache counters matched upstream `prompt_tokens_details.cached_tokens`.
The script completed with `status: verified` and exit code 0.

Reproduce against the currently configured model:

```sh
./node_modules/.bin/tsx scripts/verify-capability-cache.ts
```

This command sends four short model requests and incurs provider usage. Cache
expiration, upstream routing, model changes, session reload/compaction and
unrelated external extensions are outside the proved same-session capability
load invariant. A failed or missing usage sample remains a failed acceptance,
not a claimed success.

## Compatibility

Capability operations are no longer independently advertised native tools. Callers
must load the capability, then use `call_capability` with its operation name and
arguments. Baseline read/edit/write/shell/plan/requirements tools stay native.
The gateway executes sequentially; `spawn_agent` retains its own bounded parallel
scheduler. Existing conversations with the old tool list require extension reload
or a new session; this intentionally establishes a new fixed prefix once.

## GitHub distribution synchronization

The sibling `pi-agent-extensions-github` distribution uses a flat source layout.
The fixed transport and its prerequisite session/runtime changes were mapped to
that layout. Test scripts use local declared executables with no developer-home
paths. Private/local memory, credentials, Pwiki, pi-main, and project-local
`.pi` skill mirrors were not copied. The source-only skill-deployment test was
not included, because those skill mirrors are absent from the distribution.
The live numbers above were measured in the development checkout; distribution
verification results are recorded separately.

### Independent distribution verification

- `npm ci --offline --ignore-scripts --no-audit --no-fund`: succeeded,
  414 packages installed from cache. The root lockfile preserves exact versions
  and includes the 87 MCP archive URLs/integrity records missing from the original
  development-root lockfile, recovered from the matching workspace lockfile.
- `npm test`: strict typecheck and **213 tests passed** (61 parallel-agent,
  147 work-mode/lib/root tests, 5 existing stream-compat tests). The development
  skill-deployment test is omitted because its private/local mirrors are absent.
- All 145 development TypeScript files were accounted for: 140 match after normalizing trailing blank lines, 4 tests have flat-layout
  path/scanning adaptations, and the single
  source-only skill-deployment test is not distributed. Production implementations
  are identical to the development version.
- The distribution ran its own live acceptance script using its own installed
  dependencies: `status: verified`, exit code 0. Cache-read counters were 5,376
  (initial), 5,376 (warm), 5,632 (after load), and 5,760 (repeat load plus Plan).
  Its request-prefix hash exactly matched the development-run hash above.
- `git diff --check` passed. Publication status is recorded separately by Git
  history and remote readback.
