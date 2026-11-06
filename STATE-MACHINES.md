# Application state machines and confirmed defects

## Scope and evidence

This is the single state-machine inventory and audit record for the application.
It covers durable domain state, engine execution, provider and artifact work,
HTTP authorization, browser interaction and recovery, and service-worker storage.
A machine can be explicit (an enum) or implicit (a promise, map membership,
identity token, timer, or combination of flags). Independent state dimensions are
listed separately rather than presenting every Cartesian combination as a state.
Stateless validation, formatting, and geometry functions are not machines.
Deployment administration in `ops/` and external providers' internal machines
are outside the application boundary.

The pre-fix revision was `95daa2c`. Findings below were reproduced against an
isolated candidate with private storage and dynamic listeners before changing
implementation. Source paths and symbols identify the enforcing boundaries;
line references are navigation aids and may move. Regression names preserve the
reproducible evidence after temporary logs are removed. Inspection alone is not
proof that every provider, crash point, or filesystem interleaving is safe.
Product behavior remains in [PRODUCT.md](PRODUCT.md); component and trust
ownership remains in [ARCHITECTURE.md](ARCHITECTURE.md).

Navigation:
- [Confirmed issue groups](#prioritized-issue-groups)
- [Server metadata, identity, and HTTP](#server-metadata-identity-and-http-boundaries)
- [Scheduler, persistence, and billing](#scheduler-persistence-generation-service-and-billing-state-machines)
- [Executor, provider, and artifacts](#executor-provider-output-and-artifact-machines)
- [Browser and editor](#browsereditorlive-query-machines)
- [Service worker and offline retention](#service-worker-pwa-registration-and-offline-retention)
- [Observed verification](#integration-verification)

## Prioritized issue groups

Priority is impact, not discovery order. P1 concerns session/credential isolation;
P2 concerns lost user intent, recoverable work failing, or misleading durable
state. These are confirmed reachable defects, not merely type-permitted states.

| Priority | Issue and related defects | Confirmed pre-fix evidence | Repair status |
| --- | --- | --- | --- |
| P1 | [#28: Session-scoped worker reads](https://github.com/klntsky/slopgrid/issues/28): stale response/body/fallback handoffs; delayed initialization replaces the new scope | Old/private reads returned 200 after logout/switch; an old read obtained new-partition bytes; valid replacement-session offline data became unavailable | Fixed; regressions, handler smoke, and affected PWA browsers passed |
| P1 | [#29: OAuth attempt fencing](https://github.com/klntsky/slopgrid/issues/29): disconnect revocation, old key overwriting newer connection, old sign-in surviving newer cancellation | Disconnected callback returned 302 instead of 400; three stale completions succeeded instead of failing | Fixed; regressions and real-HTTP smoke passed |
| P2 | [#30: Creation intent ownership](https://github.com/klntsky/slopgrid/issues/30): editable pending submission and abandoned completion replacing newer draft/navigation | Held POST allowed prompt mutation; abandoned completion navigated away from a newer draft | Fixed; both failing-before browser regressions passed |
| P2 | [#33: Grid-local editor identity](https://github.com/klntsky/slopgrid/issues/33): pending title UI follows a direct history jump to another grid | Destination retained the prior grid's disabled title editor | Fixed; delayed-response browser regression and interactive navigation passed |
| P2 | [#32: Attempt-local storage recovery](https://github.com/klntsky/slopgrid/issues/32): mandatory reference/artifact reads bypass or hide retry | One injected EIO terminally failed generation or judging before provider dispatch | Fixed; regressions and real executor smoke passed |
| P2 | [#34: Grid retry transport ownership](https://github.com/klntsky/slopgrid/issues/34): body retry leaves named-reader cancellation lifetime | Cancelling the last reader did not abort the second transport | Fixed; regression and shipped-handler smoke passed |
| P2 | [#31: Durable retry cleanup](https://github.com/klntsky/slopgrid/issues/31): billing pause/restart abandon retry but retain transient errors | Stored pending work retained an obsolete generation/rate-limit error | Fixed; regressions and disk-backed runtime smoke passed |

## Server metadata, identity, and HTTP boundaries

### Creation admission and receipt

Authority: `createGridRoutes` in `server/routes/grids.ts`, `creationRequest` in
`server/creation-request.ts`, and `Store.insert`. States: unaccepted input;
validated/admitted candidate; saved grid with optional owner-scoped receipt;
start acknowledged, definitely not started, or start outcome unknown. These
admission/outcome states are separate from the saved grid's execution status.

Invariants:

- Only admitted concrete inputs enter workflow planning and storage. Reference
  access and effective model compatibility are checked before insertion.
- A receipt identifies an owner, request identity, and canonical input fingerprint.
  The immediate insertion transaction checks again after asynchronous admission,
  so concurrent identical submissions resolve to one grid. A changed fingerprint
  is a conflict, not another interpretation of the same intent.
- Receipt replay reads the existing grid and never implicitly resumes inference.
  An uncertain engine acknowledgement does not mean insertion failed.
- Completed artifact reuse may make a grid complete without inference; otherwise
  authoritative engine admission rechecks ownership, publication and credentials.

| Before | Event and guard | After / effect |
| --- | --- | --- |
| No receipt/grid | Invalid input, inaccessible reference, model/admission/rate rejection | No saved grid; return explicit failure |
| No receipt/grid | Valid candidate; insert transaction wins | Private paused grid, tasks and receipt committed atomically |
| Candidate after async admission | Concurrent matching insert already won | Existing grid returned; loser does not insert or start another grid |
| Existing receipt | Same fingerprint and current owner access | Return existing grid snapshot; no inference replay |
| Existing receipt | Different fingerprint | 409; original grid unchanged |
| Saved, unfinished | First start succeeds | Return saved running state |
| Saved | Engine unavailable or storage acknowledgement uncertain | Return saved ID with unknown start outcome; recover by reading |
| Saved | Admission draining or authorization required | Return saved ID with not-started outcome |

No additional invalid receipt transition was confirmed. Rechecking inside the
transaction, rather than the early lookup alone, is the concurrency guarantee.

### Balance admission and concurrent credential changes

Authority: `createInferenceGuard` in `server/inference-policy.ts`. States are
checking capacity, awaiting explicit low-balance confirmation, rejected, and
admitted with a saved concurrency ceiling. This is setup admission, not a worker
reservation or a guarantee that later provider calls will succeed.

| Before | Event / guard | After / invariant |
| --- | --- | --- |
| Capacity check | Provider lookup fails | Rejected; no grid insertion or implicit override |
| Image balance below threshold | Explicit override absent | Low-balance decision returned; no inference admission |
| Low-balance decision | User explicitly continues | Recheck capacity and normal admission; no automatic spending override |
| Capacity accepted | Automatic parallelism | Estimate unique unfinished generations plus unfinished judgments; shared generations counted once |
| Capacity accepted | Concurrent session rotation/disconnect/key change observed on reread | Rejected; do not save a stale session snapshot |
| Capacity accepted | Same live credential/session or explicit bearer key | Save only current session concurrency; preserve newer OAuth/session fields |

The synchronous session reread after provider awaits is the concurrency fence
(`inference-policy.ts:99-112`). Engine admission separately reauthorizes under
the publication transaction. Manual-key checking (`server/manual-keys.ts`) has
checking -> confirmed/rejected states but never installs the key in server
session/account storage.

### Publication, visibility, slug, title, and ownership

Authority: `Store.publish` (`server/store.ts`), `publicationError`
(`server/grid-policy.ts`), and `Store.claim`/`Store.identify`. Publication is an
irreversible dimension: unpublished private, published unlisted, published
public. A title is editable metadata, not execution input. Slug unclaimed/claimed
and anonymous/account ownership are independent dimensions.

Invariants: publication eligibility and engine admission serialize through
immediate SQLite transactions; publication freezes author attribution and
execution changes. A published grid can retain paused/failed cells: publication
is not synonymous with successful generation. Slugs are globally unique and
permanent once claimed. Claiming anonymous work does not claim another account's
work or rewrite frozen attribution. Workflow saves update execution fields only,
so engine progress does not overwrite newer title/publication metadata.

| Before | Event / guard | After |
| --- | --- | --- |
| Unpublished private | Save private | No publication |
| Unpublished private | Publish unlisted/public, no actively generating or queued runnable cells | Published at chosen visibility; author frozen |
| Unpublished with active/runnable work | Publish | Conflict; unchanged |
| Published unlisted | Promote to public | Published public; frozen author retained |
| Published public | Demote, or any published grid returns private | Conflict; unchanged |
| Published at same visibility | Repeat save | Idempotent; optional first valid public slug claim remains possible |
| Public, slug absent | Claim valid unclaimed slug | Permanent slug; unique database index arbitrates concurrent claims |
| Slug claimed | Change/remove slug, or another grid claims it | Conflict; no partial publication |
| Owned grid | Rename | Title metadata changes; task inputs/artifacts unchanged |
| Anonymous work | Successful account identification and claim transaction | Account-owned work, references and favorites; frozen author unchanged |
| Account-owned work | Another account claims same browser's anonymous identity | Existing account ownership unchanged |

These boundaries were inspected; no additional publication/slug/title race was
reproduced in this audit.

### Session identity and independent credential state

Authority: `createSessionReader` (`server/session.ts`), session rows, and
`createIdentityRoutes` / `createAuthRoutes`. Identity states: no live session,
live anonymous session, live account session, revoked old session. Credential
states: disconnected or OAuth-connected; manual keys are a separate browser-only
path. Anonymous ownership continuity uses `anonymousId`, not a revoked session
cookie as authorization.

| Before | Event | After / invariant |
| --- | --- | --- |
| Missing, malformed, or revoked cookie | Session-requiring request | Fresh anonymous session and cookie |
| Live session | Request | Renew cookie; publish non-credential cache partition hash |
| Anonymous/account session | Successful sign-in | Claim permitted anonymous content; rotate session; delete old session; preserve initiating provider connection |
| Account/anonymous session | Sign out | Rotate to anonymous; old session and both authorization attempts revoked; provider connection retained |
| OAuth-connected | Disconnect | Key and pending/in-flight key authorization removed |
| Any | Manual bearer key request | Use supplied key for that operation; do not persist it into session/account |

Session rotation and ownership changes are transactional. A revoked session
cannot redeem an output grant or continue receiving authorized event snapshots.
External authentication is not the same machine as inference authorization.

### OAuth attempts and completion ownership (#29)

Each identity/key flow owns at most one current attempt in its session. States:
absent, awaiting callback, exchanging, completed/revoked. `OAuthAttempt.state` is
the identity; `exchanging` makes callback consumption single-use. `validOAuth`
rejects an expired, wrong-state or already-exchanging attempt. The attempt remains
persisted during exchange; absence is revocation, not permission to commit.

| Before | Event and guard | After / effect |
| --- | --- | --- |
| Absent or any older attempt | Start | New awaiting attempt replaces and invalidates older completion |
| Awaiting | Matching valid callback | Persist exchanging before awaiting provider |
| Awaiting/exchanging | Wrong state, expired callback, duplicate consumed callback | Reject without consuming a different current attempt |
| Exchanging | Provider returns; same attempt still current | Key saved and attempt removed, or identity claimed and session rotated |
| Exchanging | Provider returns after replacement, disconnect, or rotation | Failed redirect; no credential/identity mutation |
| Exchanging | Provider fails | Failed redirect; clear only this attempt if it is still current |
| Awaiting identity | User denies sign-in | Failed redirect; consume this attempt; older exchanges remain revoked |
| Awaiting/exchanging key flow | Disconnect | Absent; late callback/completion cannot reconnect |

Confirmed pre-fix interleavings:

1. Start key authorization, Disconnect, then return callback. Disconnect removed
   only the key; the old callback still succeeded (302 instead of rejected 400).
2. Begin key exchange A, Disconnect while upstream is held, release A. Callback
   had deleted its attempt before awaiting; the absence check accepted A and
   silently reconnected.
3. Hold exchange A; start and finish B; release A. B had also removed its pending
   marker, so A overwrote B's newer credentials.
4. Hold GitHub exchange A; start B and cancel B; release A. With both pending
   markers absent, A claimed identity and rotated the session despite replacement.

`tests/oauth-races.test.ts` controls only external exchanges and exercises real
HTTP routes, provider adapters and SQLite. All four failed before the repair and
passed afterward, along with existing identity and manual-key scenarios. Repair:
retain a single-use exchanging attempt, compare its exact identity at commit,
clear only the matching attempt in cleanup, and revoke key attempts on Disconnect.

### Favorites and personalized bootstrap

Authority: `createFavorites` (`server/favorites.ts`), `Store.claim`, and
`createGridBootstrap`. Per viewer/grid: unstarred or starred; account and anonymous
stores are separate. A missing/inaccessible target is not a starred readable grid.
Bootstrap captures session, favorite membership and listing windows in one read
transaction.

| Before | Event | After / invariant |
| --- | --- | --- |
| Unstarred, target visible | Set starred=true | Starred; idempotent conflict handling |
| Any membership | Set starred=false | Unstarred, even if target is no longer readable |
| Unstarred, target hidden/missing | Set starred=true | Not found; no new membership |
| Anonymous favorites | Sign-in claim | Merge into account without duplicates; remove claimed anonymous entries |
| Stored membership, access changed | List/IDs | Filter through current grid access |
| Listing request | Snapshot bootstrap | Session and personalized lists from the same database snapshot |

Authorization is server-owned; browser notifications request rereads and cannot
supply authoritative membership. No new server-side membership defect was
confirmed.

### Output authorization bridge

Authority: `createOutputAccess` (`server/output-access.ts`), `canViewGrid`, and
live session rows. Private website access: no grant -> expiring one-time grant ->
cell-scoped output cookie -> authorized request, or expired/revoked. Public output
access does not require this private bridge.

| Before | Event / guard | After |
| --- | --- | --- |
| No grant | Authorized private website open with safe path, quota available | Expiring grant bound to session/cell/path; redirect to isolated host |
| No grant | Public website open | Redirect directly to isolated public output |
| Grant issued | Redeem on matching cell host before expiry; live session can still view | Consume grant; set encrypted cell/session cookie; redirect without exposing grant to generated code |
| Grant issued | Wrong cell, expired grant, deleted session or lost access | Reject; no grant-derived authorization |
| Redeemed | Repeat redemption | Reject: consumed grant absent |
| Output cookie | Asset read | Resolve live app session and recheck grid policy each time |
| Output cookie | Session rotation/logout | Old cookie no longer authorizes private content |

The origin boundary isolates generated code; the live-session lookup, not cookie
possession alone, enforces revocation. No additional bridge defect was confirmed.

### Server event stream and cursor recovery

Authority: `createEventRoutes`, `createStreamHistory`, and engine version tuples.
States: unauthorized/rejected; subscribed writable; backpressured; ended/closed.
Cursor states: absent/unknown, present for this viewer+grid, expired/evicted.

| Before | Event | After / invariant |
| --- | --- | --- |
| Request | Current grid access and connection quotas pass | Subscribe engine and web metadata events; begin heartbeats |
| Protocol 2 request | Matching viewer/grid history cursor | Delta from immutable baseline |
| Protocol 2 request | Unknown, wrong-scope, expired or evicted cursor | Current full snapshot, then deltas |
| Subscribed | New version at least current version | Reauthorize live session/grid; publish projection; retain bounded immutable baseline |
| Subscribed | Older epoch/sequence | Ignore; never publish state regression |
| Subscribed | Session removed/access lost | End stream |
| Subscribed | Browser write buffer already needs drain | Destroy stream; client reconnects rather than buffering unbounded snapshots |
| Subscribed | Heartbeat | End if session revoked; otherwise keep alive |
| Any open stream | Close/disconnect | Clear timer, unsubscribe, decrement quota once |
| Cursor retained | TTL/byte/entry budget exceeded | Evict old cursor; next resume falls back to snapshot |

History is private to a session and grid, bounded by bytes and entries. Cursor
recovery never performs inference. The private engine transport coalesces
backpressure separately, as described in the scheduler inventory below.

### Storage initialization, references, catalog, and process lifetimes

| Machine and authority | States | Transition table |
| --- | --- | --- |
| Database initialization: `initializeDatabase`, `server/database.ts` | New, supported historical schema, canonical, unsupported, migration failed | New/supported -> immediate migration transaction -> canonical before Store use; unsupported -> startup error; failure -> transaction rollback, no normal use |
| Reference canonicalization: `migrateReferences`, `server/image-references.ts` | Historical file, content-addressed bytes installed, canonical metadata committed, historical copy removed | Install canonical bytes -> commit hash/dimensions metadata -> remove historical bytes; restart finishes interrupted cleanup; missing historical artifacts do not invent bytes |
| Uploaded references: `createImageReferences.add` | Browser-only file, installed content-addressed blob, owned logical reference, grid-linked reference | Validate bytes/dimensions -> install blob without replacing concurrent identical blob -> transactional reference; admission links selected references to grids; public grids authorize their selected images |
| Reference loader: `createImageReferences.loader` | Absent cache entry, pending read, fulfilled bytes, rejected read | First lookup -> shared promise; concurrent lookups share it; success retained for executor scope; rejection deletes entry so retry can read again |
| Model catalog: `createModelCatalog`, `server/model-catalog.ts` | Empty, refreshing, available snapshot, closed | First read -> single shared load; success -> snapshot and listeners; missing image endpoint metadata -> prior per-model metadata; success/failure schedules refresh while open; close removes listeners/timer and prevents rescheduling |
| Web process: `server/index.ts` | Bound/startup queue, engine/frontend ready, serving, stopping | Bind dynamic/configured port -> await engine/catalog/frontend while retaining requests -> install app and hand off queued live requests -> on signal close catalog/HMR/connections/database |
| Engine process: `server/engine.ts` | Socket probe, storage/recovery, listening accepting/draining, shutdown wait, stopped | Reject live prior engine; remove only refused unchanged stale socket -> initialize storage and recovery -> listen; signal drains and waits for all accepted work and durable settlement before close |
| Development launcher: `server/dev.ts` | Acquiring worktree runtime, engine ready, web ready, teardown | Own a worktree-specific runtime/lock -> start engine then web -> publish assigned origin -> signal/child exit tears down owned processes and temporary resources |

Invariants: old-format data handling stays at initialization, not runtime dual
readers. Physical content identity does not confer logical ownership. Rejected
reference promises must be evicted so transient storage retry can progress.
Catalog refresh is single-flight; a stale available snapshot remains readable
while refreshing. Runtime launchers own their resources, not another worktree's
listener or database. These auxiliary lifetimes were inspected; no additional
confirmed defect was promoted from them.


## Scheduler, persistence, generation service, and billing state machines

### Inventory and authoritative state

| Machine | State and authority | Symbols / evidence |
| --- | --- | --- |
| Grid admission and execution | Durable `running`, `paused`, `complete`; optional `manual`, `billing`, `restart` interruption; live runtime membership is separate from status | `Grid`, `server/domain.ts:616-620`; `Jobs.start`, `jobs.ts:107-171`; `Jobs.pause`, `jobs.ts:173-207`; `Jobs.settleState`, `jobs.ts:505-523` |
| Task attempt | Durable `pending`, `running`, `complete`, `error`, attempt identity and failure; process-local retry decoration/count | `WorkflowState`, `domain.ts:532-537`; `task-lifecycle.ts:9-35`; `Jobs.failAttempt`, `jobs.ts:394-433` |
| Dispatch reservation and settlement | No call -> durably admitted call -> executing/aborted-but-unsettled -> durable settlement -> released slot | `RunningCall`, `jobs.ts:25-32`; `Jobs.dispatch`, `jobs.ts:237-322`; `Jobs.current`, `jobs.ts:342-348`; `Jobs.run`, `jobs.ts:436-503` |
| Dependency readiness | A judge is blocked until its referenced generation is complete; generation is immediately eligible when pending | `Jobs.ready`, `jobs.ts:224-235`; `Jobs.settleState`, `jobs.ts:505-523` |
| Owner fairness and worker budgets | Owner concurrency limit, last-allocation ordinal, actual unsettled calls; global and grid limits constrain selection | `Jobs.start`, `jobs.ts:122-160`; dispatch filtering, `jobs.ts:257-275`; `selectWorker`, `worker-allocation.ts:1-28` |
| Owner retry cooldown | Absent / future deadline / expired; deadline is independent of idle owner allocation membership | `Jobs.cooldowns`, `jobs.ts:43-45`; `Jobs.dispatch`, `jobs.ts:241-250`; `Jobs.failAttempt`, `jobs.ts:404-417` |
| Persistence queue | Healthy empty / flushing FIFO / blocked with timer and pending operations; waiters may be waiting or aborted | `Persistence`, `persistence.ts:10-89`; storage error whitelist, `persistence.ts:3-7` |
| Engine admission mode | Accepting / draining, orthogonal to active execution and persistence health | `createGenerationService`, `generation-service.ts:55-77,108-118`; shutdown predicate, `engine.ts:47-62` |
| Snapshot publication | Durable epoch plus monotonically increasing process-local sequence; streamed progress has a separate 300 ms notification timer | `generation-service.ts:20-40,93-106`; `Jobs.snapshot`, `jobs.ts:91-104`; `Jobs.progressUpdated`, `jobs.ts:379-392` |
| Generation event transport | Connected writable / backpressured with one newest pending serialized snapshot / ended or destroyed / unsubscribed | `serveGeneration`, `generation-server.ts:46-79` |
| Inference-call ledger | `running`, `succeeded`, `failed`, `cancelled`, `interrupted`; canonical SQL columns override JSON payload for status, phase, attempt and charged cost | `CallDetails`, `billing.ts:14-28`; `readCall`, `billing.ts:62-71`; `Billing.observe`, `billing.ts:77-161`; `Billing.recover`, `billing.ts:282-290` |
| Startup recovery | Stored running grid or any stored running task -> paused restart with unfinished work requeued; ledger running calls -> interrupted | `recoverInterruptedGrids`, `recovery.ts:5-19` |

### Grid and task transition tables

| Before | Event / guard | After and invariant |
| --- | --- | --- |
| Paused or newly created grid | Authorized start, writable storage, admission transaction commits | Running, interruption cleared; non-running/non-complete tasks queued; completed tasks and unsettled active tasks retained. Runtime installation and notification occur only after commit (`jobs.ts:113-169`, `generation-service.ts:55-77`). |
| Already running live grid | Repeated start | Same runtime; no duplicate admission (`jobs.ts:118-119`). |
| Complete grid through API | Start | Complete unchanged (`generation-service.ts:57`). |
| Any non-complete grid | Manual pause | Paused/manual; runtime key removed; retries cleared; active task state queued and controllers aborted; slots remain reserved until settlement (`jobs.ts:173-205`). |
| Running grid(s) for dispatch owner | Non-temporary billing failure | Paused/billing; queued work stops; other active calls continue; cancelled retry failures must be durably cleared (`jobs.ts:350-362,419-422`). |
| Any grid with its last unsettled call finishing | All tasks complete | Complete and interruption removed (`jobs.ts:505-508`). |
| Running grid with its last unsettled call finishing | No ready pending task remains | Paused; terminal task errors remain available (`jobs.ts:509-522`). |
| Stored running grid, or grid with stored running task | Process startup recovery | Paused/restart; running and pending tasks requeued, complete/error tasks retained; no provider request starts (`recovery.ts:5-19`). |

| Task before | Trigger | Task after / important side effect |
| --- | --- | --- |
| Pending or error | Explicit queue | Pending; error, errorCode and retrying cleared; transient generation progress reduced to thinking pointers and usage (`task-lifecycle.ts:15-26`). |
| Pending and ready | Durable dispatch admission succeeds | Running with fresh attempt token; stale output/progress/failure removed; only then install `running` reservation and execute (`jobs.ts:280-318`, `task-lifecycle.ts:29-35`). |
| Running/current | Executor returns commit closure | Output installed and complete only inside durable settlement; retries removed (`jobs.ts:436-500`). |
| Running/current | Temporary 429, or qualified 402 with Retry-After, retries below five | Pending; retrying only while grid remains running; owner cooldown is max(existing, now + max(Retry-After, bounded exponential jitter)); slot released only after persistence (`jobs.ts:394-417`; `failures.ts:81-111`). |
| Running/current | Billing failure | Pending with billing diagnostic; pause all running grids for dispatch owner (`jobs.ts:419-422`). |
| Running/current | Other failure or exhausted temporary retries | Error, final diagnostic retained, no automatic retry (`jobs.ts:423-432`). |
| Running/aborted | Late success or failure after pause, including immediate resume under a different owner | No late output commit; settlement uses current queued task state. Old dispatch owner/slot stay pinned until durable settlement (`jobs.ts:342-348,471-500`). |
| Pending with temporary failure | Billing pause or restart abandons automatic retry | Pending without the abandoned temporary failure; explicit resume is required. This durable cleanup was incomplete before this audit's fixes. |

A paused grid is allowed to have running tasks after a billing pause and before those calls settle. A pending task is allowed to have an unsettled cancelled call after manual pause. Consequently, neither grid status nor task status alone measures occupied workers. The `running` map is the reservation authority (`jobs.ts:37-39,76-77,365-376`). A pending billing-failed task may intentionally retain its actionable billing diagnostic; the cleanup fix is specifically for other tasks whose temporary retry was cancelled.

### Concurrency, fairness, retry, and settlement invariants

1. A task has at most one unsettled call: `ready` requires no `running` entry, and dispatch changes durable task state before executor entry (`jobs.ts:224-235,299-318`). Attempt identity plus aborted signal gates progress and publication (`jobs.ts:342-348`).
2. Actual unsettled calls, not projected cell statuses, enforce global/owner/grid capacity. Owner selection minimizes active count, then oldest last-allocation ordinal. Existing calls are not preempted (`worker-allocation.ts:8-25`, `jobs.ts:257-275`). Within one owner's grids, candidate selection follows runtime insertion/task order; there is no separate grid-fairness promise (`jobs.ts:257-269`).
3. Dispatch captures credential owner and attempt. Pause/resume can replace a runtime wrapper, but the old reservation is released only on settlement and counts against its original owner (`jobs.ts:25-32,148-156,290-317,365-376`).
4. Owner cooldown survives owner-runtime release; resume does not bypass it. Expiration schedules a wakeup independently of worker occupancy (`jobs.ts:43-45,241-250`). Only 429 and qualified in-flight-budget 402 retry automatically; ordinary billing failures do not (`failures.ts:96-111`). The maximum is one initial attempt plus five retries (`jobs.ts:403-405`). Retry counters and cooldowns are process-local, not crash-persistent; restart deliberately pauses rather than automatically continuing.
5. Provider execution and billing work are not replayed on recoverable settlement storage failures. A FIFO synchronous settlement closure retries storage; publication rechecks call identity on each retry (`jobs.ts:468-500`). Nonrecoverable faults are intentionally outside the retry policy, not silently converted into successes (`persistence.ts:1-7,74-78`).
6. Grid runtime release follows durable emission/settlement and requires no unsettled calls (`jobs.ts:59-69,365-376`). This makes a blocked storage operation visible as unhealthy and keeps drain from declaring completion early.
7. `retrying` is deliberately not serialized in `Store.saveWorkflow`; durable temporary error/errorCode are serialized. The durable cleanup bugs below concern those error fields, not a persisted retrying flag (`store.ts:326-333`). Cells are projections, not execution authority (`workflow.ts:82-140`).

### Persistence and admission transition tables

| Before | Trigger | After / side effect |
| --- | --- | --- |
| Empty healthy | Submit write | Push FIFO operation, flush synchronously unless retry timer exists (`persistence.ts:48-50`). |
| Flushing | Write succeeds | Shift that operation, run its committed callback once, continue FIFO (`persistence.ts:71-82`). |
| Flushing | Whitelisted storage failure | Retain head operation; schedule exponential timer from 1 s up to 30 s; later retry the same write (`persistence.ts:59-78`). |
| Any | Failed synchronous admission | Enqueue read probe; block unrelated dispatch; caller must explicitly retry admission, so recovery cannot implicitly start denied work (`persistence.ts:52-58`, `jobs.ts:137-146`). |
| Blocked | Provider/storage waiter | Wait for all queued writes; abort rejects that waiter and unregisters its listener (`persistence.ts:28-46`). |
| FIFO becomes empty | Recovery | Reset backoff, invoke recovered scheduler callback, resolve waiters (`persistence.ts:83-85`). |
| Any | Non-whitelisted write failure | Propagate failure; disk exhaustion/programming errors are intentionally not retried (`persistence.ts:1-7,74-78`). |

| Admission mode | Event | Result |
| --- | --- | --- |
| Accepting | Drain | Draining=true; accepted active/queued/backoff work continues. Drain is not pause/cancel (`generation-service.ts:111-114`; `generation-drain.test.ts:8-57`). |
| Draining | New non-idempotent start | DRAINING rejected inside immediate publication/admission transaction (`generation-service.ts:60-76`). |
| Draining | Accept | Draining=false; future admission allowed (`generation-service.ts:115-118`). |
| Either | SIGTERM/SIGINT | Drain; wait until runningCalls=0, activeGrids=0 and persistence healthy; then close connections/database (`engine.ts:47-65`). |

Admission checks ownership, publication and credentials inside the transaction; blocked persistence rejects before runtime installation (`generation-service.ts:42-77`, `jobs.ts:113-146`). The HTTP admission boundary is described above.

### Snapshot and transport transitions

| State/event | Transition / invariant | Evidence |
| --- | --- | --- |
| Generation process starts | Increment durable epoch; process-local sequence starts at zero | `generation-service.ts:20-21` |
| Snapshot read | Merge durable metadata with live projected cells/status; shallow-copy each live cell; attach strictly increasing sequence within epoch | `jobs.ts:91-104`, `generation-service.ts:33-40` |
| Streaming progress | Notify immediately if throttle expired, otherwise at most one pending 300 ms flush; ignore superseded runtime/task identity | `jobs.ts:379-392` |
| Subscribe | Register listener and send initial snapshot in same turn; unsubscribe removes listener | `generation-service.ts:93-106` |
| Writable stream receives snapshot | Serialize immediately; flush pending newest snapshot | `generation-server.ts:51-70` |
| Stream backpressure | Keep only newest serialized pending snapshot; do not accumulate every intermediate update | `generation-server.ts:51-69` |
| Drain event | Flush pending snapshot if still open and no writable backpressure | `generation-server.ts:52-64` |
| Close | Clear pending state, remove drain listener, unsubscribe | `generation-server.ts:74-78` |

### Ledger transitions and charge invariants

| Before | Event | After / persisted fields |
| --- | --- | --- |
| No call | Observe phase | Fresh immutable call ID/start time/cell/task attribution, running status; judge phase uses judgment task, all other phases generation task (`billing.ts:82-129`). |
| Running | Provider metadata/usage update | Same call ID; merged metadata serialized as a queued snapshot (`billing.ts:99-134`). |
| Running | Complete with finishReason=stop | Succeeded; completion, usage, finishedAt (`billing.ts:135-145`, `failures.ts:114-118`). |
| Running | Complete with other finish reason | Failed with finish diagnostic, preserving reported completion/usage (`billing.ts:135-145`). |
| Running or failed | Failure / cancellation | Failed or cancelled with finishedAt; cancellation clears error/diagnostic fields; any previously reported usage remains (`billing.ts:147-158`). |
| Succeeded | Later fail callback | Succeeded unchanged; no terminal success downgrade (`billing.ts:148`). |
| Running in stored ledger | Startup recovery | Interrupted and finishedAt; cost/usage/attribution retained; repeat recovery idempotent (`billing.ts:282-290`). |

- Canonical cost distinguishes missing cost from zero-cost calls. SQL `cost_usd` overrides payload representation; page totals include cancelled/failed/interrupted charges (`billing.ts:62-71,230-280`).
- `Billing.task(taskId, attemptId)` sums every phase in that attempt; without an attempt it selects latest call by timestamp then insertion order (`billing.ts:163-188`). This avoids merging prior retries into a current attempt while preserving historical ledger charges.
- `gridSpent` sums each workflow task's ledger once, not each projected cell; shared generation estimates use maximum rather than summing duplicate cells. A running generation's current-call estimate is added only when its latest call has no reported cost, so a reported zero replaces the estimate (`billing.ts:189-228`).
- Billing persistence snapshots capture JSON/status/cost at save invocation and queue them FIFO under one call ID; upsert does not mint duplicate call IDs during storage retry (`billing.ts:99-127`).


**Group S1: Make abandoned retry failure cleanup durable (P2, fixed).** Two independently reachable transitions shared the stale temporary-diagnostic failure mode. Impact: paused/recovered grids expose obsolete rate-limit failure text even after retry decoration has disappeared and no retry is scheduled; runtime and durable snapshots disagree during billing pause/release. No duplicate inference or lost charge was demonstrated.

1. **Owner-wide billing pause drops task cleanup.** Reproduction: start two one-cell grids for one owner at concurrency two; fail A with 429/Retry-After so it settles pending with temporary error; fail B with non-temporary 402. Before the fix, `pauseOwner` cleared A's retry/error in memory but passed an empty task list to `emit`; durable grid status became paused/billing, runtime released, and the next snapshot reloaded A's old temporary error. Parent's corrected red run observed `This cell could not be generated.` where undefined was expected, `tests/jobs.test.ts:257`, log `/tmp/slopgrid-scheduler-red.log`. Fix: collect retrying tasks, clear them, and pass that exact changed list to persistence (`jobs.ts:350-362`). Focused behavioral regression: `billing pause durably clears another grid's scheduled retry`, `tests/jobs.test.ts:234-265`; it asserts durable failure cleanup, no live runtime, billing pause reason, and no timer-driven request after 60 seconds.
2. **Restart during pending backoff retains transient error.** Reproduction: persist running grid with pending task carrying a 429 temporary failure and another permanent-error task; invoke startup recovery. Before the fix only running tasks were requeued, so the pending task's error survived although the process-local retry timer was gone. Parent's red run observed `Rate limited` instead of undefined, `tests/recovery.test.ts:266`. Fix: when a grid needs interruption recovery, queue/persist both running and pending tasks; preserve complete/error tasks (`recovery.ts:9-17`). Focused regression: `restart clears scheduled retries without erasing permanent task failures`, `tests/recovery.test.ts:222-277`; checks permanent failure preservation and repeated-recovery idempotence.

### Candidates, rejected hypotheses, and limitations

- **Not a bug: paused grids with active tasks.** Explicit billing policy lets in-flight calls finish. Existing tests cover pause-with-active calls and resume without duplicate inference (`tests/jobs.test.ts:389-444`).
- **Not a bug: drain continues dispatch and cooldown retries.** Draining restricts new admission only; stopping accepted work would violate current regression contract (`tests/generation-drain.test.ts:8-57`).
- **Not a confirmed defect: replayed output under storage retry.** Scheduler deliberately retries a synchronous commit closure rather than rerunning provider work and rechecks attempt identity. Real database-lock coverage exists in `tests/generation-persistence.test.ts:176-246`; artifact-install idempotence itself belongs to the executor audit.
- **Not a confirmed defect: fairness across an owner's own grids.** Current selector is owner-fair, not round-robin across that owner's grids. No contrary user contract was found.
- **Not a confirmed defect: persisted retrying flag.** It is deliberately omitted from serialization. The reproduced durable mismatch concerned persisted error fields.
- **Policy limitation, not broadened:** retry counts/cooldowns do not survive process restart; startup intentionally requires manual resume. Non-whitelisted disk/programming faults do not auto-recover. No production-disk-full or power-loss experiment was performed.
- No additional candidate in this slice reached evidence sufficient for a code change. Read-only inspection is not proof against every possible external provider or filesystem ordering.

## Executor, provider, output, and artifact machines

### Machine inventory and invariants

| Machine / owner | State representation | Required invariants and enforcing boundary |
| --- | --- | --- |
| Workflow graph construction (`createWorkflow`) | Generation partition map; pending generation/judgment tasks; cell generation/judgment IDs | Equal generation partition keys share generation work; each judge depends on exactly its own generation; judge-only criteria do not become generation input. `workflow.ts:19-79`. |
| Cell projection (`projectWorkflow`) | View of generation output/progress and dependent judgment | A cell references a generation and, if present, a judgment of that generation; projection never writes execution state back into tasks. Broken references throw. Generation completion exposes judgment status while output remains available. `workflow.ts:82-141`. |
| Execution attempt (`createWorkflowExecutor().run`) | Generation or judge branch; captured attempt context; current/cancelled guard | No provider dispatch after storage preparation if signal is aborted or attempt identity is stale; generation progress from stale attempts is ignored. Key is required. `workflow-executor.ts:49-128`. |
| Generation installation (`WorkflowCommit`) | `installed` boolean and memoized `output` closure | Provider work runs once; synchronous storage commit may be retried; files install once and the same output metadata is returned afterward. Artifact identity is generated per attempt, not per commit retry. `workflow-executor.ts:86-87,129-152`; scheduler `jobs.ts:468-485`. |
| Streaming generation progress / settlement | Draft, thinking, thinking source/ID, usage estimate, preview; finish(success) | Persist thinking before checkpointing its IDs; ignore stale progress; successful finish clears ephemeral progress; failed finish retains durable thinking and chat-template draft, plus billed usage. `workflow-executor.ts:100-120,154-167`. |
| Generation/judge dependency and cache release | Generation output; dependent judge statuses and retrying flags | Judges require an output; do not release cached raster while any dependent judge is unsettled or retrying. Explicit clear releases completed generation caches. `workflow-executor.ts:52-55,169-197`; dispatch dependency guard `jobs.ts:224-234`. |
| Direct vs template generation (`generateAttempt`) | Direct branch or sequential template request callback; previous prefix length | Direct calls use the same request context; template calls preserve signal, observer, beforeRequest, session identity and previous-prefix boundary across all calls. Missing pricing fails before dispatch. `generation-attempt.ts:24-70`. |
| Prepared request construction | Image settings and loaded bytes, or text messages/system/schema/options/budget | Each selected reference ID must resolve; no unresolved ID is silently dropped. Template messages are encoded into wire-only cache boundaries without mutating saved transcript. Prepared format turns chat-template subcalls into Markdown. `prepared-inference.ts:25-145,233-237`. |
| Request/provenance signature | Canonical SHA-256 over semantic prepared request | Reference content is identified by media type/hash, not upload ID; pricing estimates and output-token ceilings do not affect text request identity. Reuse separately proves budget fit. Template signatures incorporate transcript roles/content/reference hashes. `prepared-inference.ts:149-231`. |
| Provider model catalog | Absent or timestamped model array; five-minute TTL | A successful complete text/image catalog merge replaces the cache; failed requests leave no partial catalog. Batch-only models excluded. Concurrent misses are not single-flight. `provider.ts:110-210`. |
| Provider image-endpoint catalog | Per canonical image model: absent / pending-or-resolved promise / TTL expired | Concurrent same-model lookups share one promise; failures evict it for later retry; aliases resolve to canonical target. `provider.ts:212-240`. |
| Provider inference preparation/dispatch | prepare -> request -> signature/result | Text requires priced model and budget; images prepare directly. No hidden SDK retry (`maxRetries: 0` in request adapters). `provider.ts:259-322`; `inference.ts:168,209`; `judge.ts:75`. |
| Observed transport call | Observer recorder -> persistence gate -> abort check -> HTTP response metadata | Billing observer belongs to this attempt and phase; all HTTP calls wait at beforeRequest and check signal before dispatch; status/generation ID retained before payload processing. `inference.ts:35-54`. |
| Image response adaptation | Response clone metadata, optional thinking, completion/cost; decoded result | Actual image bytes and media type are installed, not provider URL; completion must be successful; cost omitted by adapter is recovered from response body. `inference.ts:107-190`. |
| Text streaming and finalization | Text/thinking accumulators; byte estimates; optional final metadata; failure | Only first choice is read; raw reasoning avoids normalized duplicates; consume entire stream, record final usage, reject explicit stream failure/non-stop completion, then parse output. Reasoning-only token exhaustion has a specific error. `inference.ts:55-95,192-304`. |
| Judge streaming and validation | Stream drain -> completion/usage snapshot -> structured output | Failed judgments retain actual usage; only strict boolean verdict/nonempty explanation objects accepted; result count equals criteria count; unsuccessful completion or malformed output fails instead of creating judgment output. `judge.ts:16-23,40-125`. |
| Artifact filesystem (`OutputFiles`) | Absent / pending directory / installed immutable artifact; separate thinking snapshots and reference blobs | Artifact files need safe relative paths, nonempty inventory and nonexisting destination; temporary tree is cleaned on failure; rename installs complete bundle. Reference hard links cannot replace concurrent upload; thinking snapshots use temp+rename. `files.ts:21-116`. |
| Artifact availability/read | Inventory and optional thinking/source pair; available/unavailable/error | No traversal or empty inventory; all required files and optional thinking must exist/read successfully. Missing/unreadable content is unavailable; recoverable storage faults must remain distinguishable so a caller can retry (confirmed defect below). `files.ts:121-167`. |
| Artifact removal | Reference callback -> keep or remove bundle/thinking directory | Referenced artifacts are not deleted; unreferenced artifact removal includes thinking owned by that artifact ID. `files.ts:186-194`. |
| Artifact reuse | Signature buckets; per-task fit predicate; per-artifact availability promises | Copy output only for identical semantic signature, compatible output-token/template step budget, and complete readable artifact/thinking inventory; clone provenance so tasks do not share mutable metadata. Reuse marks generation complete without inference. `artifact-reuse.ts:13-118`. |
| Judge input preparation | Loaded bundle -> format-specific transcript or image -> optional SVG raster promise | HTML is unsupported; missing expected file fails before judging; chat output is validated and source images reattached; generated image bytes are a separate judge input. `judge-artifact.ts:15-105`. |
| SVG judge cache | WeakMap by Store, map by generation ID, pending/resolved raster promise | Different generations sharing artifact bytes have independent cancellation; same generation's judges share preparation; rejection evicts only matching cached promise; release is explicit. `judge-artifact.ts:9-13,80-93`. |
| Incremental website parser (`PartialWebsite`) | Offset, stack of object/array frames with key/value/colon/comma states, string escape/unicode substate, files/directories/changed sets | Input is an append-only cumulative prefix; stream unfinished string contents; accept safe paths only; a file cannot also be a directory or have a file ancestor. Preview is provisional, not final JSON validation. `partial-website.ts:3-135`; strict final validation `output-format.ts:15-35`. |

### Transition tables

#### Attempt and installation

| From | Event / guard | Action | To |
| --- | --- | --- | --- |
| Not started | run without key | Throw before preparation | Failed |
| Preparing generation | references available | Check abort/current, prepare/provider call | Requesting |
| Preparing judge | generation output absent | Throw before provider call | Failed |
| Preparing judge | references + generated artifact available | Check abort/current, invoke judge | Requesting |
| Preparing either | recoverable storage read error | Suspend at persistence recovery and retry only preparation | Preparing |
| Preparing either | cancelled or no longer current | Abort; never dispatch | Cancelled |
| Requesting generation | chunk and current | Update thinking/draft/usage/preview | Streaming |
| Requesting generation | stale chunk | Ignore chunk | Stale |
| Requesting either | provider fails or final validation fails | Throw to attempt owner; keep billing evidence | Failed |
| Requesting generation | provider and parse succeed | Capture result; return commit closure | Ready to install |
| Ready to install | first commit | Atomic artifact write, construct output | Installed |
| Installed | transaction retry invokes commit | Return same output; never request provider again | Installed |
| Requesting judge | valid successful judgment | Return results-only commit closure | Ready to commit |
| Any finishing attempt | finish(success) | Clear ephemeral generation progress | Settled success |
| Any finishing attempt | finish(failure) | Keep durable thinking / template draft / usage | Settled failure |
| Settled generation or judgment | all dependent judges terminal and not retrying | Release raster cache | Released |

The recoverable-read transition was absent for generation references and obscured for judge artifacts before this audit's fix; see confirmed issues.

#### Provider call and parser

| From | Input / event | Guard / action | To |
| --- | --- | --- | --- |
| Prepared | SDK issues HTTP fetch | Create recorder, await beforeRequest, check signal | Dispatchable |
| Dispatchable | HTTP response | Record status/generation ID | Responded |
| Responded text | text delta | Append text and approximate byte-based usage | Streaming |
| Responded text | raw reasoning delta | Prefer readable detail text/summary over duplicated legacy reasoning | Streaming |
| Streaming | end/error | Await optional completion/usage/metadata, retain billing evidence | Finalizing |
| Finalizing | explicit stream failure or finish reason other than stop | Fail call and throw | Failed |
| Finalizing generation | valid output format | Return parsed file map | Successful |
| Finalizing judge | schema valid and criteria count matches | Mark complete; return results | Successful |
| Image responded | valid SDK image and stop completion | Return byte content/media type | Successful |
| Any request phase | abort/error | Fail recorder with cancellation flag; throw | Failed/cancelled |

#### Artifact availability, reuse and filesystem installation

| From | Event / guard | Action | To |
| --- | --- | --- | --- |
| Artifact absent | write valid nonempty safe file map | Create private pending directory, write all files | Pending |
| Pending | all writes succeed | Rename pending directory to artifact ID | Installed |
| Pending | any write/rename fails | Remove temporary directory; rethrow | Absent |
| Installed | second write | Reject overwrite | Installed |
| Availability unknown | invalid inventory or missing required file/thinking | Return unavailable | Unavailable |
| Availability unknown | read succeeds | Return immutable-byte bundle | Available |
| Availability unknown | recoverable read fault | Preserve error for execution retry | Retryable failure |
| Reuse candidate | signature differs or budget proof missing | Skip candidate | Not reused |
| Reuse candidate | compatible signature/budget but incomplete artifact | Skip candidate | Not reused |
| Reuse candidate | signature/budget/inventory all fit | Clone output, set complete | Reused |
| Installed | remove while referenced | Return false without removal | Installed |
| Installed | remove while unreferenced | Remove artifact and owned thinking | Absent |

#### Partial website string parser

| From | Character / event | Action | To |
| --- | --- | --- | --- |
| No string | object/array opener | Push frame; identify root files-array entries | Frame key/value |
| Frame key/value | quote | Start token; for content start publishing empty draft when path known | In string |
| In string | ordinary character | Append token; publish growing content if path accepted | In string |
| In string | backslash | Set escape flag | Escaped |
| Escaped | u | Start four-hex-digit buffer | Unicode escape |
| Escaped | other character | Decode JSON escape (tolerant fallback for provisional invalid input) | In string |
| Unicode escape | fourth character | Decode if valid hex; otherwise omit provisional invalid escape | In string |
| In string | closing quote for key | Save key | Colon |
| In string | closing quote for path/value | Publish if complete path/content pair exists | Comma |
| Frame | colon/comma | Select value or next key/value | Value/key |
| Frame | close brace/bracket | Pop frame, mark parent comma | Parent frame |
| Publish | unsafe/path-directory/file-ancestor conflict | Ignore provisional entry | Unchanged files |
| Publish | accepted path and content | Update null-prototype map + changed set | Changed files |


### Confirmed storage-recovery defect and repair

#### EX-1 (P2): Recoverable execution input reads become permanent task failures

Tracked together in [issue #32](https://github.com/klntsky/slopgrid/issues/32).

Group: execution/storage recovery boundary. Two independent paths violate the same invariant: a transient storage fault before inference must not terminally fail generation or judging, and retrying storage must not replay a provider call.

1. Generation input references were loaded directly at `workflow-executor.ts:88-91`, unlike the judge reference path at lines 62-64. EIO propagates to `Jobs.failAttempt`, whose provider-failure classification does not classify disk errors as temporary (`jobs.ts:393-432`, `failures.ts:96-111`). Reachable state: valid pending generation -> running attempt -> one transient reference read EIO -> permanent generation error, no provider call.
2. Judge artifact preparation is already inside `context.retryStorage` (`workflow-executor.ts:65-67`), but `OutputFiles.readArtifact` caught every error and returned undefined (`files.ts:146-166`). `loadJudgeMessages` then converted it into generated-output-unavailable (`judge-artifact.ts:41-43`). Reachable state: durable successful generation + pending judge -> one transient artifact read EIO -> permanent judge error while the valid generated artifact remains installed.

Impact: healthy artifacts/references become unusable until manual retry; grids pause instead of recovering through the existing persistence policy; judge failure can follow successful paid generation. No duplicated billing is necessary to trigger this defect.

`tests/executor-storage.test.ts` reproduced both failures with real Store, Jobs, executor, provider HTTP transport and artifacts, faulting only one filesystem read with EIO. Both failed before the repair and passed afterward. The standalone run also verified installed text/verdicts with one provider call and billing entry per stage.

Implemented fix: generation reference loading now runs inside context.retryStorage (`workflow-executor.ts:89-91`); `OutputFiles.readArtifact` rethrows recoverableStorageError rather than converting it to an unavailable bundle (`files.ts:165-168`), preserving existing unavailable semantics for missing/unreadable artifacts. `hasArtifact` remains an optional reuse probe: false skips reuse rather than terminally failing a live task, so its policy is intentionally unchanged. No new UI strings or exported signature changes.


### Candidates and non-bugs (not confirmed incidents)

- Same-generation SVG preparation shares the first caller's abort signal (`judge-artifact.ts:80-92`). Independent cancellation could reject another same-generation consumer. Existing runtime cancels all tasks of a paused grid together; generation IDs differ across reused grids, and cache keys are generation IDs rather than artifact IDs. Existing `tests/judging.test.ts:668-770` explicitly covers cancellation isolation across different generations sharing one artifact. No current independent same-generation cancellation route was established; no speculative cache redesign.
- Image-endpoint TTL replacement followed by rejection of an older still-pending request could evict a newer entry because catch deletes by ID without identity comparison (`provider.ts:222-239`). API-only counterexample: hold an old HTTP response, advance time past TTL, cache a successful replacement through a concurrent direct Provider call, reject the old response, then observe a subsequent cache miss. Parent LSP confirmed the sole production caller is `model-catalog.ts:22`; its one pending refresh (`35-48`) prevents the application from initiating overlapping refresh generations, and its error path (`24-29`) retains previous metadata. Therefore the direct-API ownership counterexample is not a confirmed reachable application bug, and no workflow/UI impact was established. A proposed regression requiring direct concurrent API calls was removed before any implementation change; no issue or speculative fix. HTTP has no header/body timeout (`http.ts:3-6`), but elapsed time alone does not bypass the caller's single-flight owner.
- Model catalog cache misses are not coalesced (`provider.ts:110-119`), so concurrent initial prepares can duplicate catalog fetches. The cache is published atomically after both catalogs resolve; no invalid workflow state established.
- History FIFO expiry pruning assumes nondecreasing insertion times (`stream-history.ts:14-20`). Conditional counterexample with ttl=60 time units: put A at now=100 (expiry=160), clock rolls back, put B at now=0 (expiry=60), then get B at now=70. Pruning stops at unexpired A and can return expired B. TTL is preserved for ordinary nondecreasing insertion times; the failure requires an external wall-clock discontinuity. No production clock-jump reproduction or expiry guarantee under clock discontinuity was established; no speculative redesign or implementation change.
- PartialWebsite is deliberately tolerant and does not certify final JSON validity. Its only caller feeds cumulative append-only text; authoritative completed HTML is separately parsed and rejects duplicate/conflicting/unsafe paths (`output-format.ts:15-35`). A provisional preview differing from invalid final output is not a confirmed persistence violation.
- `hasArtifact` intentionally treats faults as unavailable during optional reuse (`files.ts:121-145`); unlike mandatory judge preparation, this is not a terminal execution failure. No change was made to reuse policy.

### Sequential conversations, preview files, raster workers, and private IPC

These machines refine execution stages rather than introduce additional task
statuses. A single chat-template attempt may own several sequential provider
calls; temporary website files are not committed output artifacts.

| Machine / authority | State vector | Invariants |
| --- | --- | --- |
| Chat-template execution: `fillChatTemplate`, `server/chat-template.ts:20-99` | Ordered filled history, remaining budget/call count, step usage and accumulated thinking | Supplied messages retain order; each blank becomes one assistant response; an implicit final blank is added when needed; previous blanks complete before the next call; no partial template is committed as final output |
| Temporary website previews: `WebsitePreviews`, `server/website-previews.ts:24-97` | Per-task parser, unique preview attempt, revision, changed files, flush timer | Current entry and scheduler attempt must still match inside queued persistence; only safe parsed paths are served; invalidated preview URLs cannot read a newer attempt |
| SVG raster process: `rasterizeSvg`, `server/svg-raster.ts` | Not spawned, worker running, resolved/rejected, terminating | Abort checked before spawn and after result; success/error/exit settle once; worker is always terminated and abort listener removed on exit |
| Engine RPC/subscription client: `generationClient`, `server/generation-client.ts` | Opening, protocol accepted/rejected, response decoding; subscription active/ended/aborted | Protocol mismatch and malformed response become unavailable; ordinary RPC has a deadline; subscriptions are owned by AbortSignal and EOF requires a fresh snapshot, not mutation replay |

| Machine / before | Event | After / effect |
| --- | --- | --- |
| Template at supplied message | Advance sequence | Copy supplied role/content/images to history without provider call |
| Template at blank | Abort check and per-remaining-call allowance | Await one completion using history so far; stream completed prefix plus provisional answer |
| Template call succeeds | Required text output exists | Record step usage/token bound; deduct reported/estimated cost or reserved allowance; append assistant answer; continue |
| Template all blanks filled | Finalize | Serialize ordered conversation, sum known usage, preserve separate thinking |
| Template any call | Failure/cancellation | Attempt fails; executor may preserve draft/thinking but retry restarts blanks from accepted template |
| Preview absent | Parsed entry page available | Create attempt-scoped preview and flush changed files immediately or through one throttle timer |
| Preview flush queued | Entry and attempt still current | Install changed files by temporary rename; advance revision; notify |
| Preview flush queued | Entry removed/replaced or attempt stale | No file publication or notification |
| Preview any | Pause/failure/completion/explicit clear | Cancel timer, revoke entry, queue file removal and remove preview pointer |
| Raster running | Message/error/exit/abort | Resolve PNG or reject; terminate worker in finally |
| RPC opening | Bad protocol, socket failure, timeout, malformed body | Unavailable; caller recovers authoritative state |
| Subscription opening/active | Valid nonempty line | Decode and deliver snapshot |
| Subscription active | EOF, malformed line or socket failure | Abort transport and notify disconnect once unless deliberately unsubscribed |
| Subscription any | Unsubscribe | Abort without disconnect notification |

Budget accounting never invents a reported charge: unknown template-step cost
reserves its allowance while the billing ledger remains authoritative. Optional
artifact reuse separately checks every recorded template step against its
destination allowance (`chat-template.ts:101-129`). Preview storage is provisional
and replaceable; installed final generation remains the durable artifact boundary.
No additional invalid transition was confirmed in these refinements.

## Browser/editor/live-query machines

### Inventory and identity boundaries

| Machine | State vector / owner | Required invariant | Evidence |
| --- | --- | --- | --- |
| Editor/draft | formatSelected, input(format, caseAxes, parameter ownership, case IDs, variableNames, judge), sourceGridId, reuseArtifacts; sessionStorage draft | Every parameter has one owner: common, rows, or columns; native dimension and case-axis rules differ; edits preserve stable case IDs; cancel leaves original draft | `src/create/draft.ts:31-80,102-261,264-320`; `src/create/change-axis.ts:60-82,179-206,358-734` |
| Submission identity | sessionStorage creation fingerprint + frozen body + creationRequestId | Same intent reuses identical request/body after response loss; automatic capacity changes must not create another intent; success clears receipt only for the active editor | `src/create/draft.ts:39-51,78-81`; `src/create/use-create-submission.ts:26-44,56-93` |
| Submission/upload exclusion | attempted, validationError, upload count/ref, mounted lifetime, upload AbortController, inference mutation | At most one upload/submit episode owns an editable draft; navigation ends UI ownership even if server creation succeeds later | `src/create/use-create-submission.ts:21-34,47-93`; `src/create/use-create-form.ts:93-114`; `src/pages/create.tsx:233-236` |
| Reference intake | per-picker reading ref, busy/error/mounted; IndexedDB local-ID records; upload replacements Map | Completion must not target an unmounted picker; one upload per repeated local ID; prepared input is cloned; local references replaced everywhere before server creation | `src/create/image-input.tsx:21-67,127-145`; `src/create/reference-files.ts:14-55,75-117`; `src/create/draft.ts:301-309` |
| Inference | mutation idle/pending/success/error + lowBalance nullable | LOW_BALANCE becomes an explicit user decision, never an automatic spending override; success clears balance dialog | `src/use-inference-mutation.ts:6-48`; `src/components/inference-dialogs.tsx:4-58` |
| Billing interruption | grid paused/private/editable + interruption billing + dismissed flag | Billing prompt only for resumable owned grid, suppressed while low-balance prompt exists | `src/pages/grid.tsx:45,68-87`; `src/grid/use-grid.ts:26-27,179-188` |
| Grid read/recovery | query status/fetchStatus/data/error; id-scoped retryAfter; per-options serverDue | Permanent errors stop retry; temporary reads retry with jitter; HTTP Retry-After is a floor; offline cache read is allowed | `src/grid/recovery.ts:63-118`; `src/grid/retry-policies.ts:5-27`; `src/grid/use-grid.ts:28-58` |
| Recovery gate | localDue, serverDue callback, suspended, timer, AbortSignal | Hidden/offline suspends network; return to foreground drops local jitter but retains server floor; abort removes all listeners/timer | `src/grid/recovery.ts:11-60` |
| SSE episode | id,cursor,grid,failures,checkedRead + controller + connection firstMessage/deadline | Delta only applies to matching prior cursor; cursor and snapshot move atomically; stream cancels competing grid GET; failed connection probes at most once until valid message | `src/grid/use-grid.ts:29-43,79-175`; `shared/grid-delta.ts:42-69` |
| Delta codec | full replacement / append / fields+removals | Only append strings; objects/arrays copied, never mutate prior cache; length-changing arrays replace; own-property access prevents prototype-key confusion | `shared/grid-delta.ts:8-65` |
| Grid actions/edit-fork | inference mutation + configure mutation + transient recovery | pause/retry/edit UI excludes simultaneous actions; configure uses original grid input, saves source/reuse identity then navigates; ambiguous temporary command error reads current server state, does not blindly repeat command | `src/grid/use-grid.ts:176-218,226-243`; `src/grid/grid-header.tsx:88-135` |
| Favorites/session | session owner key; favorites owner-scoped IDs/pages; shared per-owner/grid mutation state | Never show prior owner's placeholder favorites; all duplicate controls share pending; cancellation precedes authoritative refetch; 401 also refreshes session | `src/queries.ts:53-86,89-245`; `src/components/favorite-button.tsx:6-55` |
| Favorites cross-tab | BroadcastChannel + localStorage nonce; visibility/focus/pageshow refresh lifetime | Broadcast payload carries invalidation only, never trusted favorite state; stale in-flight GET cannot overwrite post-mutation truth; unsubscribe aborts refresh continuation | `src/favorite-changes.ts:1-72`; `src/queries.ts:126-161,229-237` |
| Session/connection | session query + localStorage API key + connect/disconnect/logout mutations | Manual key is stored only after server validation; logout uses full document reload to destroy account caches/streams | `src/components/connection.tsx:17-48,124-164`; `src/components/account.tsx:14-18`; `src/openrouter-key.ts:1-24`; `src/queries.ts:62-73,247-268` |
| Publication | closed/open, selected visibility/slug, confirming, remember, pending/error | Published cannot return private; public cannot downgrade; slug validation gates save; skip-confirm preference only persists after successful confirmation | `src/grid/publish-grid.tsx:16-70`; `src/components/publish-dialog.tsx:31-70,110-120,185-204` |
| Grid title | viewing/editing + save mutation + uncontrolled current input | Enter/blur saves once via blur; Escape discards and restores button focus; failure retains edit for retry; successful PATCH refreshes grid/list/favorites | `src/components/editable-title.tsx:26-80`; `src/grid/grid-title.tsx:47-62` |
| Website preview | frames[{url,ready,offline}], offlinePath, streaming | Keep one ready visible frame while loading next; at most two frames; streaming coalesces intermediate snapshots; completion may replace pending preview; offline retains existing live document state | `src/grid/website-preview.tsx:57-105,109-134` |
| Website bridge | trusted source window, output-path prefix, scroll MessageChannel/deadline | Offline navigation accepted only from mounted frame and same-origin output subtree; scroll reply schema validated, ports always closed, detached replacement cannot become ready | `src/grid/website-preview.tsx:62-85,124-132`; `src/grid/frame-scroll.ts:3-38` |
| Output workspace | persisted global mode/per-cell overrides + expanded output/reference selection | Preferences keyed by grid ID; unavailable thinking/judgment falls back to output; expansion only for extant usable cell/reference; dialog owns Escape ahead of expanded pane | `src/grid/output-grid.tsx:22-39,60-121,123-189`; `src/pages/grid.tsx:67` |
| Text/Markdown retention | streaming draft, lastDraft, query data/error, following flag | Streaming does not fetch final text; final read may retain last streamed draft until success; user scroll-up stops thinking tail-follow | `src/grid/markdown-preview.tsx:26-40,45-59,94-110,113-139`; `src/grid/text-output.ts` |
| Viewport gesture | optional pan/resize drag, pointer identity/capture; pinch, scale, sizes | Only captured pointer controls drag; pinch excludes drag; bounded positive dimensions, scale <=3; persist sizes on release; ignore expanded/interactive content for pan | `src/grid/viewport.tsx:38-62,125-175,178-223,239-348` |
| Item scroll sync | idle/hover/scroll, source session, pending source, touch contact/focus, geometry dirty/maps | Followers never acquire ownership from programmatic scroll; disconnected/inert views excluded; one frame scheduled; all observers/global listeners removed on disconnect | `src/grid/use-item-scroll-sync.ts:26-75,134-157,224-301,312-459,483-512` |
| Listing pagination | no anchor / requested / loading + page/location/width/scrollY | Placeholder data cannot finish restoration; another location/page/manual scroll cancels anchor; correction requires unchanged width and user scroll | `src/components/grid-listing.tsx:60-77,109-180`; `src/queries.ts:23-47,183-207` |
| Model/case/chat editing | filter/range anchor, drag insertion target; case-ID focus/filter maps; message role/reads/unfilled WeakMap | Reorder retains case identity; image reads exclude structural message edits; role changes cannot put images into non-user messages; unfilled text can be restored locally | `src/create/model-selector.tsx:64-89,128-169`; `src/create/case-table.tsx:175-179,208-244`; `src/create/chat-editor.tsx:39-95,139-162` |
| Small interaction lifetimes | delete confirmation, reorder pointer capture/focus, tooltip/popover open, copy status, theme transition, navigation menu | Confirmation bound to unchanged content; drag cancellation cannot commit; stale theme transition cannot clear current transition; route change closes navigation | `src/create/deletable-input.tsx:18-57`; `src/create/reorder-handle.tsx:26-36,66-135`; `src/create/axis-editor.tsx:233-239`; `src/grid/grid-parameters.tsx:67-73`; `src/components/copy-button.tsx:30-39`; `src/theme.tsx:64-91`; `src/layout.tsx:17-25` |

Pure presentation modules (formatters, prices, warnings, feedback and benchmark summarization) derive their state from the machines above; they do not independently own server operation transitions. API/grid read bookkeeping is included; worker handling of those messages is outside this slice. SVG and image retention, billing and remaining interaction machines are detailed below.

### Editor and creation transitions

| From | Event/guard | Next | Side effect/invariant |
| --- | --- | --- | --- |
| no valid saved draft | mount | default SVG draft, formatSelected=true in editor | Malformed/old-version draft falls back; current schema parsed (`draft.ts:57-73,264-270`) |
| editable draft | select format; no loss or confirmation accepted | compatible transformed draft | Remove incompatible settings, collapse dimensions, preserve compatible case IDs, normalize chat, disable HTML judging (`draft.ts:102-261`) |
| editable draft | destructive dimension/collapse; cancel | same | `confirmInputAction` denies transition before reducer |
| editable draft | common/to-axis/to-common/dimension/single | new owner/layout | Invalid ownership actions no-op; neutral unowned axis becomes one case (`change-axis.ts:197-206,397-511`) |
| editable case axis | add/remove/move case | same layout with changed ordered case records | Cannot remove final case; move bounds checked; IDs move with records (`change-axis.ts:550-564,610-620`) |
| editable case axis | add/remove/rename variable | same axis, revised columns of variable fields | Add applies to every case; removal leaves null slot (stable token numbering); rename rewrites prompt references (`change-axis.ts:363-380,565-609`) |
| editable draft | toggle judge | add defaults / strip all judge-owned fields | HTML cannot enable judge (`change-axis.ts:695-732`) |
| editable | Generate with blocking validation/capacity/upload/pending operation | same | No new creation request (`use-create-submission.ts:56-64`) |
| editable | Generate valid | upload/preparing | Clone validated input; sequential upload de-duplicates local IDs; controller owns cancellation |
| upload/preparing | local upload succeeds | preparing with uploaded reference IDs | Update draft and delete local file; already uploaded refs survive retries |
| upload/preparing | upload error | editable with error | No creation POST; finally releases upload counter/controller |
| upload/preparing | unmount | abandoned | Abort upload; do not start inference when signal aborted |
| prepared | fingerprint equals prior intent | POST prior frozen body | Same creationRequestId even if automatic parallelWorkers changes |
| prepared | fingerprint differs | POST fresh body | New random creationRequestId saved before request |
| submitting | network/server failure | editable with receipt retained | Explicit retry reuses same request identity |
| submitting | LOW_BALANCE | decision dialog | No override unless user chooses Continue anyway |
| submitting | success while editor still owns episode | clear draft/receipt, navigate created grid | Receipt response includes started/not_started/unknown; client opens saved grid for all outcomes |
| submitting | editor leaves | abandoned server operation | Server may finish; stale completion must not clear/navigate newer editor (confirmed defect below) |

### Inference, read, stream and recovery transitions

| From | Event/guard | Next | Effect |
| --- | --- | --- | --- |
| mutation idle/error | pause/retry | pending | Reset other action; retry undismisses billing prompt |
| pending | LOW_BALANCE | low-balance dialog | Retain current grid; expose check/override |
| pending | temporary failure | recovery/read | Extend shared id-scoped Retry-After; refetch once; reset command mutations only after read settles |
| pending | permanent failure | displayed command error | No blind automatic mutation retry |
| query no data | successful GET | grid data | Query key includes grid ID |
| query any | temporary status/network/timeout | jittered retry | 408/429/500/502/503/504; 15-second read deadline |
| recovery waiting | hidden/offline | suspended | Timer removed; listeners retained |
| suspended | visible+online | waiting/ready | Local jitter waived, server Retry-After retained |
| any wait | abort | rejected/cleaned | Listeners and timeout removed |
| data live, unpublished, online | effect mount | connecting | Wait recovery, open protocol=2 EventSource, send since cursor if available |
| connecting | first snapshot before 15s deadline | streaming | Store snapshot+cursor; cancel GET; update cache; reset checkedRead |
| streaming | delta.base matches cursor | streaming next snapshot | applyDelta then atomically advance cursor |
| streaming | invalid JSON/base/delta | lost/no cursor | Clear episode snapshot/cursor, disconnect, permit full snapshot reconnect |
| connecting/streaming | error or first-message deadline | disconnected/backoff | Close EventSource; one fallback GET if no usable resumed stream; infinite retries with jitter |
| disconnected | visible+online+cooldown done | reconnecting | Preserve cursor/prior snapshot if protocol remained valid |
| stream episode | 30s healthy before disconnect | next failure count reset | Avoid permanent escalation after healthy intervals |
| stream any | navigation/offline/not-live/unmount | aborted | Close stream and stop retry loop |
| live data | grid complete/published | nonlive read mode | Disable SSE; automatic focus/reconnect query reads become available |

The query+stream fallback is deliberately not ordinary polling. `automaticRead` suppresses focus/reconnect reads when an unpublished live grid has a cursor. Stream disconnection uses a `checkedRead` probe until a valid message resets it. This is an explicit anti-request-storm invariant, not an assumption that infinite retries imply infinite GETs.

### Favorites/session transitions

| From | Event | Next | Invariant/effect |
| --- | --- | --- | --- |
| unknown owner | session succeeds | owner-scoped IDs/pages enabled | No previous-owner placeholder |
| ready star | click | shared owner/grid mutation pending | Same grid controls disabled together; cancel IDs GET |
| pending mutation | success | refresh pending | Broadcast nonce invalidation, then cancel all favorite GETs and refetch |
| pending mutation | failure | refresh pending + error | Refresh authoritative truth even after ambiguous response; 401 invalidates session |
| ready/error | Retry | query retry or repeat desired star change | Session errors take precedence over IDs errors, then mutation |
| any mounted page | other-tab nonce/focus/pageshow/visible | refresh | Invalidate only; do not import foreign state |
| synchronization mounted | unmount | aborted | Remove listeners/channel, stop post-cancel refresh continuation |
| account connected | logout success | new settings document | Destroy all private query/stream state |
| manual-key editing | valid key request succeeds | locally connected | Key only persisted after validation |
| connected | disconnect | key cleared immediately, server mutation pending | Server session query invalidated on success |

### Publication/title/preview transitions

| From | Event/guard | Next | Invariant/effect |
| --- | --- | --- | --- |
| publish closed | PUBLISH/change/claim click | selection | Initialize current visibility/slug; clear mutation error |
| selection | choose private | close without POST | Only possible before publication |
| selection | choose unlisted/public | confirmation or saving | Initial publication requires confirmation unless remembered |
| confirmation | Cancel/Escape and not busy | selection | Do not publish or persist preference |
| selection/confirmation | Save and valid | pending | Freeze choices while pending |
| pending publication | failure | same dialog/error | Retry possible; skip preference not persisted |
| pending publication | success | closed | Update exact grid and invalidate personal/public/favorite listings; remember preference only after success |
| title viewing | edit click | editing | Reset prior error, seed current title |
| title editing | Escape | viewing | No PATCH, focus returns |
| title editing | blur/Enter unchanged | viewing | No PATCH |
| title editing | blur/Enter changed | save pending | Input disabled until success/failure |
| title pending | failure | editing/error | Can correct and blur retry |
| preview empty | URL | hidden pending frame | No blank replacement of a ready document |
| preview ready | new streaming URL | ready old + pending new | Coalesce later URLs until pending frame finishes |
| preview ready+pending | latest nonstreaming URL | ready old + latest pending | Discard unfinished temporary preview |
| preview pending | load + scroll transfer, still connected | ready new | At most one visible ready frame after commit |
| preview ready online | offline | retain live document | Preserve JS/local state, discard failed pending loads |
| preview cold offline | valid source-window navigation message | new offline path pending | Same-origin output-prefix guard; worker response applies sandbox CSP |
| expanded output | Escape with no modal, or bridge Escape from its own iframe | collapsed | Unrelated frame cannot collapse selected output |

### Remaining interaction transition tables

| Machine/from | Event | Next/effect | Evidence |
| --- | --- | --- | --- |
| SVG no valid loaded source | valid prepared draft | load candidate image, retain prior source meanwhile | `src/svg-preview-image.tsx:6-20` |
| SVG candidate loading | superseding draft/unmount | detach old candidate onload; old candidate cannot replace newer image | `src/svg-preview-image.tsx:21-25` |
| SVG candidate loading | load succeeds | display source | Invalid incomplete SVG/surrogate chunk retains prior valid source |
| ContainedImage visible | image error | remember failed source; offline can show missing-cache fallback | `src/contained-image.tsx:13-17` |
| copy idle/success/failure | click | copying (duplicate click excluded) | `src/components/copy-button.tsx:30-56` |
| copy copying | resolve/reject | success/failure, then idle after 2500ms | Timer cleaned on state change/unmount |
| delete ordinary | remove and >5 words | confirmation tied to exact content | `src/create/deletable-input.tsx:18-57` |
| delete confirming | content change/Escape/outside blur | ordinary without deletion | Stale confirmation cannot delete revised content |
| reorder idle | pointer down | pointer-captured drag with original index | `src/create/reorder-handle.tsx:93-125` |
| reorder dragging | valid pointer up target | move once, clear drag, release capture | Invalid target/cancel/lost capture clears without commit |
| reorder focused | orientation arrow, valid bounds | move and restore moved handle focus | `src/create/reorder-handle.tsx:29-36,126-135` |
| case-destination popup closed | click/arrow and legal destinations | open, focus first enabled item | `src/create/axis-editor.tsx:239-260,303-325` |
| popup open | Escape/outside pointer/focus/disabled | closed; Escape restores trigger focus | All global listeners and detached tippy content destroyed on cleanup (`axis-editor.tsx:263-290`) |
| parameters popup closed/open | click/Escape/outside focus/pointer | open/closed, focus restoration | `src/grid/grid-parameters.tsx:73-128` |
| theme preference system/light/dark | explicit selection/storage/system change | resolve light/dark, apply document and meta color | `src/theme.tsx:13-20,38-63` |
| theme transition active | another selection | skip prior transition, start latest | Cleanup compares active identity before clearing transition decoration (`theme.tsx:64-91`) |
| mobile menu closed | toggle | open with outside/Escape handlers | `src/layout.tsx:17-43` |
| mobile menu open | route change/outside/Escape/item click | closed; Escape restores trigger focus | Listeners exist only during open lifetime |
| billing query | running=true | poll current offset every 2000ms | Running=false stops poll; refresh is explicit; offset scopes cache (`src/pages/billing.tsx:12-28`) |
| manual-key store | set/clear or cross-tab storage event | notify useSyncExternalStore subscribers | Key is localStorage-scoped, not sessionStorage (`src/openrouter-key.ts:1-24`) |
| any incoming grid snapshot | cache structural sharing | reject snapshot older than current (epoch,sequence) | Integrated candidate now has `src/query-client.ts:17-25` and `shared/grid-version.ts:1-6`; this also protects full title/publication responses against older snapshots |

### Confirmed defects and regression work

1. **Pending creation allows editing.** Common prompt/judge/budget inputs remained interactive while POST was held. `useCreateForm.dispatch/update` reset the mutation observer while its request continued, permitting another intent and risking loss of revised input. The red run observed the submitted prompt acquire ` changed`. `tests/e2e/creation-recovery.spec.ts` now attempts keyboard editing and a second Generate under the held POST and verifies unchanged intent, one request and one persisted grid. Repair: the editor main is inert throughout uploads/submission (`src/pages/create.tsx:233-236`); navigation remains available and native modal dialogs retain their top-layer behavior. Tracked with the next defect in [#30](https://github.com/klntsky/slopgrid/issues/30).

2. **Abandoned creation replaces a newer editor.** Mutation success survived unmount and cleared draft/receipt before navigating. Holding the response, leaving, creating a newer draft and releasing the response navigated to the old grid and discarded the newer setup. The regression in `tests/e2e/creation-recovery.spec.ts` now preserves route and draft through completion and reload. Repair: mounted lifetime is revoked on cleanup, checked after async listing invalidation and before draft clearing/navigation (`src/create/use-create-submission.ts:26-43`). The saved grid still refreshes listings, but abandoned UI no longer owns the draft.

3. **Pending title UI survives cross-grid history.** Visit A, home, B; hold B's successful title PATCH response; jump directly to A with `history.go(-2)`. The reused GridPage/header/EditableTitle showed B's disabled editor rather than A's title. `tests/e2e/grid-navigation.spec.ts` failed before the repair and now verifies A immediately, after B's response, and after reload. Both ID and slug routes key GridPage by resolved grid identity (`src/router.tsx`), resetting grid-local hook/header/dialog lifetimes. LSP reference lookup covered both callers. Tracked in [#33](https://github.com/klntsky/slopgrid/issues/33).

### Rejected hypothesis / baseline control

The corresponding held B `/retry` response did not replace A after the same history jump in the pre-fix browser run. Structural-sharing/version ordering protected that tested cache path (`src/query-client.ts:17-25`). No cross-grid snapshot corruption is claimed; the confirmed defect was transient title-editor lifetime.

### Candidate risks, not confirmed bugs

- Publication/dialog/billing transient state now shares the keyed GridPage lifetime. Only pending-title leakage was directly reproduced in the history test; no separate claim of publication or billing corruption is made.
- Awaited recovery/EventSource gap investigated without a redesign: `waitForRecovery` resolves synchronously or in native recovery event handlers (`src/grid/recovery.ts:16-23,34-59`), while ordinary browser history traversal arrives in a later task. No finite deterministic production-browser sequence was established that aborts between gate resolution and EventSource continuation (`src/grid/use-grid.ts:89-94`). Development StrictMode can replay effects (`src/main.tsx:45-52`), but replay with a live cached grid was not exercised, and installed p-retry only checks abort before/after awaiting its input (`node_modules/p-retry/index.js:239-249`). This remains an unconfirmed timing concern, not an issue/fix or demonstrated leak.
- Disconnect clears a manual key before server DELETE resolves (`connection.tsx:30-35`). If DELETE fails, UI can remain connected through server session while the local manual credential is gone. This is an observed transition in source, not demonstrated user-data loss; no unrelated authentication policy changes made.

## Service worker, PWA registration, and offline retention

### Ownership and trust boundaries

- The server authorizes each request and labels its response with `X-Slopgrid-Cache-Scope` (`server/app.ts:81-85`). `cacheScope` hashes the session ID; it is expressly not a credential (`server/session.ts:10-15`). Scope changes accompany cookie creation/rotation (`server/session.ts:50-67,80-105`). The worker does not infer identity from URL, local UI state, or message payload.
- CacheStorage retains three independent responsibilities: release/static assets (`STATIC`), the persisted current scope (`STATE`), and replaceable data under `PREFIX + scope`. Runtime `epoch` is the invalidation generation; `writes` serializes scope changes and data mutations (`public/sw.js`, top-level globals and `serial`). `pending`, `gridReaders`, and cancellation tombstones are runtime-only, lost on worker restart.
- Only same-origin requests enter the worker routing state machines. Non-GET mutations bypass caching; logout is the one intercepted mutation and clears private caches both before and after the server attempt. External generated website hosts do not enter this worker. Cached offline websites carry a response-header CSP with an opaque sandbox, no network/storage authority, and embedded resources (`server/offline-website.ts:12-15`; `saveOutput`).

### Complete machine inventory

#### W1. Build generation and release identity

Evidence: `pwa-build.ts:7-40`; `vite.config.ts:8-12`.

State: plugin unconfigured -> output-directory resolved -> shell copied -> inventory collected -> digest accumulated -> worker emitted; any synchronous filesystem failure aborts emission.

| From | Trigger/guard | Transition/effect | To |
| --- | --- | --- | --- |
| Unconfigured | Vite build plugin resolves config | Resolve configured output directory | Configured |
| Configured | `writeBundle` | Copy generated `index.html` to offline shell | Shell present |
| Shell present | Asset inventory | Include bundle `assets/`, selected public binary/font/manifest files, theme, shell | Inventory ready |
| Inventory ready | SHA-256 | Hash worker template followed by emitted asset bytes | Release ID ready |
| Release ID ready | Placeholder substitution | Emit inventory, 16-hex release ID, offline policy into `sw.js` | Installable release |
| Any build stage | Read/write fails | Throw rather than emit a successful incomplete release | Build failed |

Invariants: generated worker has concrete inventory/policy/version rather than template symbols; shell cache key includes the release; old frontend assets are preserved by the build's nonempty output directory policy. A build is not a deployment or activation. The plugin has no runtime retry state.

#### W2. Client registration and control acquisition

Evidence: `src/pwa.ts:24-54`; bootstrap caller `src/main.tsx:38-44`.

| From | Trigger/guard | Transition/effect | To |
| --- | --- | --- | --- |
| Not registered | Non-production or worker API absent | Do nothing | Unsupported/skipped |
| Controlled offline | Offline and controller exists | Avoid registration/network warmup | Existing offline control |
| Eligible | Registration allowed | Register `/sw.js`, bypass HTTP cache for updates | Registration pending |
| Registered, uncontrolled | No controller | Listen for controller change with a 5-second bound and immediate race recheck | Waiting for control |
| Waiting | Controller arrives or timeout | Remove listener and timer | Controlled or timed out |
| Controlled | Registration returns | Fire-and-forget current page and session GETs | Warmup requested |
| Any registration stage | Exception | Contain failure; browsing remains usable | Registration failed |

Invariants: no indefinite app bootstrap wait; first navigation is rewarmed only after control; registration never forces replacement of a worker controlling open pages. Warmup failures do not queue mutations or block browsing. `cacheGrid` can no-op when no controller exists.

#### W3. Client connectivity observation

Evidence: `src/pwa.ts:4-23`; HTTP observations `src/api.ts:40-60`.

State is one global Boolean `offline`, initialized from `navigator.onLine`; subscriptions are a set of listeners.

| From | Event | Effect | To |
| --- | --- | --- | --- |
| Online | Browser offline or worker offline response | Publish changed Boolean once | Offline |
| Offline | Browser online or successful online HTTP observation | Publish changed Boolean once | Online |
| Either | Same observation | No listener notification | Unchanged |
| Subscribed | React unmount/unsubscribe | Remove listener | Unsubscribed |

This is an availability hint, not proof of authorization or server reachability. Concurrent responses can update this hint; it does not grant cache access.

#### W4. Browser worker lifecycle and update policy

Evidence: `public/sw.js`, install/activate handlers; `tests/offline-format-cutover.test.ts:8-58`.

| From | Trigger | Effect | To |
| --- | --- | --- | --- |
| Installing | Install event | `addAll` release inventory into shared static cache, using release-qualified shell | Installed if successful |
| Installing | Fetch/quota failure | Reject install lifetime promise | Failed install; previous worker remains |
| Installed | Browser permits activation | Delete obsolete `slopgrid-data-v1-*` caches | Activating |
| Activating | Cleanup fulfilled | Claim same-origin clients | Active |
| Active old release | New release installs while tabs exist | Native browser waiting lifecycle; no `skipWaiting` | Old remains active/new waits |
| Active process | Browser terminates worker | Discard globals, retain CacheStorage | Restartable persisted state |

Invariants: activation keeps current-format data and older hashed assets used by cached pages/open tabs; obsolete-format snapshots are discarded, not adapted. There is no custom update-message protocol, update banner, forced reload, or `skipWaiting` message. The only supported client messages are retention and read cancellation (W11).

#### W5. Session partition synchronization and logout

Evidence: `currentScope`, `serial`, `partition`, `clearPrivate`; logout fetch handler.

State tuple: `(scope: undefined|public|session digest, epoch: integer, writes: serialized tail)`. Persisted scope lives at `/__offline_scope`. Scope is lazily loaded once per worker lifetime. Epoch is process-local, not an authentication token.

| From | Trigger/guard | Effect | To |
| --- | --- | --- | --- |
| Unknown | First `currentScope` | Read persisted scope or default public; assign only if still unknown after awaits | Known scope or newer initialized scope preserved |
| Known | Response agrees with current scope | Accept without invalidation | Same scope/epoch |
| Known | Response changes scope and its captured previous scope/epoch are current | Increment epoch, change scope, delete all data partitions, persist scope | New scope |
| Known | Stale response proposes a different current scope | Reject partition transition | Current scope unchanged |
| Any | Logout begins | Increment epoch, public scope, delete all data partitions, persist public | Public logout fence |
| Logout in flight | Server resolves or throws | Repeat clear in `finally` | Public cleared state |
| Serialized work | Work rejects | Caller observes failure; tail catches so later work is not poisoned | Queue remains usable |

Invariants: no old-epoch store can repopulate a cleared partition; scope transition invalidates all data partitions rather than retaining account history; a rejected stale transition must not deliver the stale private response. Confirmed violation/fix is detailed below. A worker cannot observe a cookie change or remote revocation until a server response synchronizes it; this is the documented offline limitation (`PRODUCT.md:575-579`).

#### W6. Replaceable cache, recency, and quota recovery

Evidence: `store`, `cached`, `serial`.

| From | Trigger/guard | Effect | To |
| --- | --- | --- | --- |
| Write queued | Expected epoch differs | Skip | Unchanged cache |
| Write queued | Epoch current | Open current partition; delete old key; put response clone | Most-recent entry |
| Put pending | Quota exceeded and an older entry exists | Delete oldest insertion-order entry; retry | Put pending |
| Put pending | Quota exceeded and cache empty | Stop | Uncached response, online request survives |
| Put pending | Other write failure | Stop | Uncached response, online request survives |
| Lookup | Queued writes finish | Capture epoch; match current partition | Hit or miss |
| Hit | Epoch still current | Reinsert to touch recency | Cached response |

Invariants: drafts and shell are outside replaceable data eviction; reads/writes do not mutate response bodies owned by consumers; ordinary cache put failure is best-effort, not a reason to fail online transport. Cache open/scope persistence failures are not swallowed by `store`'s inner put loop; the outer fetch handler has its own fallback. No fixed-size cache limit is imposed; quota drives eviction.

#### W7. Request routing, authorization, and offline fallback

Evidence: URL predicates, `network`, fetch handler; `server/routes/outputs.ts:72-83` for output readiness/authorization.

| From | Trigger/guard | Effect | To |
| --- | --- | --- | --- |
| Request received | Cross-origin | Do not intercept | Browser/network |
| GET | Inventory asset or `/assets/` | Static cache-first; fetch and best-effort populate on miss | Static response |
| GET | Supported page/API/output/offline-output | Enter network-first data path; grid/reference use coalescers | In flight |
| Network success | Authoritative scope accepted | Store only eligible response types | Authorized response |
| Network response | Non-OK authoritative response | Delete corresponding cached URL; return denial, never private fallback | Denied |
| Network failure | Request aborted | Preserve abort; do not use cached private bytes | Canceled |
| Network failure | Captured epoch no longer current | Reject cross-session fallback | Offline 503 |
| Network failure | Current-session cached entry | Return cached response; API gets offline header | Offline hit |
| Network failure | Page miss | Release-specific offline app shell if available | Offline shell |
| Network failure | Other miss | Existing page/output/API unavailable response | Offline 503 |
| Non-grid worker processing error | Outer fetch catch | One direct network retry; on failure return unavailable response | Network fallback or 503 |

Invariants: no mutation replay; no unfinished output cache entry; stale request must not read another session's cache; stale authorized response must not escape after observed identity change. Already-delivered streaming responses cannot be retroactively unread; the fix applies at the worker response handoff boundary.

#### W8. Reference revalidation and request coalescing

Evidence: `reference`, reference branch of `network`, `saveReference`; `tests/reference-cache-scope.test.ts`; `tests/reference-cache.test.ts:107-286`.

| From | Trigger | Effect | To |
| --- | --- | --- | --- |
| No flight | Reference GET | Create `reference:epoch:URL` promise | Coalesced flight |
| Flight exists | Same epoch/URL GET | Await same promise; clone response per consumer | Shared flight |
| Cached bytes | Online GET | Force same-origin/no-store; add cached ETag conditional header | Revalidating |
| Revalidating | 304 | Require cached bytes, matching ETag, identical scope and epoch; touch cache | Cached bytes reused |
| Revalidating | 304 mismatch/missing proof | Do not expose cached bytes | 503 |
| Revalidating | Unscoped 403/404 | Remove matching old cached entry when epoch current | Denied |
| Revalidating | Scoped successful body | Scope check then data cache | Fresh bytes |
| Offline | Same-epoch cache hit | Return bytes | Offline hit |
| Flight settles | Always | Remove pending key | No flight |

Invariants: HTTP image cache is not an authorization source; immutable bytes still require online scope checks; coalescing never crosses epochs; 304 is not enough without scope and matching content identity. Background attachment retention reuses existing bytes and deduplicates configured/message image IDs. Reference flights are not reader-cancelable; this is deliberate separation from grid cancellation, not a proven bug.

#### W9. Coalesced grid transport and reader ownership

Evidence: `gridRequest`, `releaseGridFlight`, `watchGridReaders`, `finishGridFlight`, `cancelGridReader`; client read lifecycle `src/api.ts:24-38,76-94`; tests `tests/reference-cache.test.ts:288-539`.

State tuple: flight key `(epoch, URL)`, controller, named reader set, background consumer count, persistent unnamed-consumer flag, body-settled flag, work promise. Named reader identity is `(clientId, UUID)`, not just UUID.

| From | Trigger/guard | Effect | To |
| --- | --- | --- | --- |
| No flight | Grid GET, no prior cancellation | Create controller/flight; strip internal read ID before transport | Fetching |
| Before dispatch | Matching cancellation tombstone | Consume tombstone; return network-error response without fetch | Canceled |
| Fetching | Same epoch/URL | Add named/background/persistent owner | Shared fetching |
| Fetching/streaming | Cancel one reader | Remove only that reader and mark canceled | Other consumers preserved |
| Fetching/streaming | No readers/background/persistent owner and body unsettled | Remove pending entry and abort transport | Aborted |
| Any owned flight | Client disappeared at 5-second sweep | Cancel that client's reader | Ownership updated |
| Successful grid JSON read | Full body parsed for cache | Mark body settled; store cleaned snapshot | Body settled |
| Other grid response | Headers returned but body pending | Wrap body to observe close/error/cancel | Streaming |
| Body done/error/cancel | Finish | Remove all reader ownership, stop sweep when empty | Settled |
| Grid processing/body-decode error | Controller not aborted; first attempt | Retry once inside the same flight with the same transport/controller and fresh scope checks | Tracked retry |
| Grid processing error | Retry rejects | Finish reader ownership; outer handler returns existing unavailable response without a third fetch | Settled error |
| Flight promise settles | Matching pending flight | Remove pending key, clear work; finish if settled/aborted | No coalescing slot |
| Background waiter finishes | Finally | Decrement background count; reevaluate abort | Remaining owners or released |

Invariants: canceling a tab cannot abort another tab or retention consumer; no-consumer stalled transports are aborted; cancellation before fetch does not hit the network; error status and retry headers survive body wrapping; aborted grid reads do not trigger the outer generic direct retry. `persistent` intentionally protects untracked consumers for the flight lifetime. Coalescing lasts through successful grid parsing, but non-OK streaming responses release the pending slot at header completion while ownership lasts until body completion.

#### W10. Completion notifications, snapshots, and output retention

Evidence: `cacheCompletedGrid`, `cleanGrid`, `saveGridOutputs`, `saveOutput`; `src/pwa.ts:55-70`; `src/grid/use-grid.ts:60-72`; `tests/e2e/pwa-grid-traffic.spec.ts`.

| From | Trigger/guard | Effect | To |
| --- | --- | --- | --- |
| Completion notification | Existing foreground grid flight | Temporarily own flight in background; await it | Snapshot inspection |
| Snapshot inspection | Epoch changed | Stop | Discarded stale retention |
| Snapshot inspection | Cache covers all requested cell/generation/judgment identities | Rewarm missing outputs, without grid refetch | Covered |
| Snapshot inspection | Missing or uncovered snapshot | One background coalesced authorized grid GET | Snapshot refreshed |
| Grid snapshot fetched | Store | Set `live=false`; omit draft/thinking/preview/estimated usage; hide unavailable output URLs | Clean offline snapshot |
| Ready cells present | Attachment scan | Deduplicate configured and filled-user-message image IDs | References retained |
| Ready output requested | Same epoch/URL retention pending | Share promise | Single retention fetch |
| Ready output already cached | Non-website | Reuse | No redownload |
| Website manifest cached | All listed pages cached | Reuse | No redownload |
| Missing ready output | Fetch success, ready header, matching scope and epoch | Store output/download/thinking or transformed website pages | Retained |
| Website bundle response | Safe HTML path | Add CSP, nosniff, referrer, offline headers; store document | Offline page |
| Website bundle complete | Pages processed | Store page list manifest | Retained bundle |
| Any output stage | Denied/not-ready/stale/error | Do not cache; clear pending key on settle | Best-effort incomplete retention |

Invariants: the message is a hint, not permission to populate cache from client-supplied grid data; only authorized HTTP snapshots are stored. Completed-output identity includes generation and terminal judgment identity. Output URLs are stable for completed work; Resume preserves completed cells (`PRODUCT.md:502-506`; grid retry route `server/routes/grids.ts:288-313`), so missing generation-query strings do not establish a regeneration bug. Partial bundle eviction is detected on the next retention attempt and fetched again. Data eviction is intentionally not transactional across a grid and all outputs.

#### W11. Message validation and early cancellation tombstones

Evidence: final `message` handler in `public/sw.js`; producers `src/pwa.ts:55-70`, `src/api.ts:81-94`.

| From | Trigger/guard | Effect | To |
| --- | --- | --- | --- |
| Any message | Missing source URL or wrong origin | Ignore | Unchanged |
| Valid source | `cancel-grid-read`, string ID <=128 characters, reader exists | Cancel named client/read ownership | Canceled reader |
| Valid source | Valid cancellation, reader absent | Record `(source.id, id)` tombstone | Pre-canceled |
| Tombstone insert | Count >256 | Drop oldest tombstone | Bounded state |
| Pre-canceled | Matching grid fetch | Delete tombstone, no transport | Canceled response |
| Valid source | `cache-grid` with valid 48-hex grid/cell/generation IDs and valid optional terminal judgment | Lifetime-extend best-effort authorized retention | Retention requested |
| Any message | Unknown/malformed type/payload | Ignore | Unchanged |

Invariants: clients cannot cancel other clients merely by guessing a read ID; tombstones are bounded; arbitrary completion payloads cannot inject cached grid content. Same-origin source validation is not an independent login proof; actual cache fill still requires server authorization. There is no mutation queue, retry message, or custom update message.

### Confirmed worker defects and repairs

**W-B1: Reject cross-session responses at every worker handoff, not just grid handoffs.** Priority: high (session-isolation/privacy boundary).

Original evidence: `network` in pre-fix `public/sw.js:507-509` returned non-grid response unchanged when `partition(next, previous, started)` rejected its stale scope. Its offline catch at original lines461-465 guarded only grids/references, allowing a request begun under Alice to consume a Bob-scoped cache entry after an observed switch. A page could also finish asynchronous body processing after scope invalidation and reach the unconditional final return (original lines536-554). The server had authorized the captured bytes under the old session; clearing CacheStorage did not revoke a response already held in memory.

Reachable traces:

1. Synchronize Alice -> start reference/session/page/output GET -> hold Alice response -> logout or synchronize Bob -> release Alice response -> original worker hands Alice's private 200 to old reader despite rejecting the stale partition.
2. Synchronize Alice -> start non-grid GET -> synchronize Bob and cache the same URL under Bob -> fail old transport -> original catch reads current partition and hands Bob's bytes to a request captured under Alice.
3. Start Alice page/body processing -> switch to Bob while body is pending -> complete Alice body -> original final return releases Alice bytes after invalidation.

These related handoff defects share one missing epoch/scope invariant in [#28](https://github.com/klntsky/slopgrid/issues/28). Impact includes stale private images/downloads/pages and session observations, not a demonstrated server authorization bypass or arbitrary remote-origin exposure.

Implemented fix: `public/sw.js:443-446` selects the existing API/page/output unavailable responses without adding visible text. Lines475-476 reject any cross-epoch offline fallback, including offline website routes. Lines518-520 reject stale scoped handoffs for all supported resource types rather than just grids; unscoped online responses still bypass private caching unchanged. Lines522-528 fence asynchronous denial cleanup, and lines563-565 recheck the accepted response epoch and scope after cache/body work. The old grid-only final check was consolidated into that shared handoff check. No exported API, registration behavior, deployment policy, or message shape changed.

Regression file: `tests/service-worker-session.test.ts`. The compact matrix covers each reference/session/page/download/offline-website route once and the same reference route under the other invalidation mechanism; it deliberately avoids the full resource-by-transition Cartesian product. Each handoff case asserts unavailable status, no stale payload, and no subsequent offline retention. Separate tests cover cross-session fallback by mutable route and a held page body. Current public/private scoped online/offline success and unscoped online passthrough controls preserve supported paths. Tests execute the shipped worker in the existing VM+CacheStorage transport fixture; no SQL, copied algorithm, deployment, or production mutation is involved.

**W-B2: Delayed scope restoration replaces a newer session scope.** P2 availability impact, grouped with the epoch-lifetime repairs in [#28](https://github.com/klntsky/slopgrid/issues/28).

A restarted worker begins loading persisted Alice scope; hold storage completion. Finish logout, then synchronize Bob and cache Bob's authorized session. Releasing the initial read formerly assigned Alice without changing epoch. The next offline read returned 503 from Alice's empty partition despite valid Bob data. Old Alice bytes were deleted; no disclosure was demonstrated by this trace.

Repair: `currentScope` assigns restored text only if scope remains undefined after all awaits (`public/sw.js:21-27`). `tests/service-worker-initialization.test.ts` failed before the repair and now verifies Bob's offline session remains reachable without restoring Alice's cache.

**W-B3: Grid body retry loses reader ownership.** P2 cancellation/resource impact, tracked in [#34](https://github.com/klntsky/slopgrid/issues/34).

Confirmed trace: a successful grid header response is followed by a body connection error. Grid snapshot decoding rejects; the old outer fetch catch retries directly with the original unowned request. The reader map still points at the first failed flight/controller. A subsequent valid `cancel-grid-read` aborts that abandoned controller while the second transport remains stalled and unowned. This is a canceled transport leak, not an inference mutation replay.

Evidence and fix: `gridRequest`, `public/sw.js:247-265`, retains the same stripped-header transport and controller across one retry within the flight, resets body-settled state before retry, and calls the normal scope-aware network handler. Terminal rejection finishes ownership (`public/sw.js:299-307`). The outer handler no longer performs a third/unowned grid fetch (`public/sw.js:651-653`). Successful/error status/body wrapping remains shared with the normal path. `tests/service-worker-grid-retry.test.ts` synchronizes on the second transport entering (not on buffered response headers), asserts two reads, and asserts cancellation aborts the retry and yields a network-error response. Parent red: `/tmp/slopgrid-worker-retry-red.log` showed retry signal not aborted at the named-cancellation assertion. Implementation followed explicit parent authorization.

### Candidate findings and limitations (not confirmed bugs)

- **Storage failure during scope persistence:** scope/epoch change precedes all cache deletions/persisted scope completion; CacheStorage open/delete/metadata-put failures can leave partial state until a later request/restart. Ordinary quota puts are handled, but this distinct metadata failure path has not been fault-reproduced here. Do not label it an authorization exploit without a trace that reaches private bytes.
- **Static retention is unbounded by release count:** old hashed assets and shells are intentionally retained for open tabs/cached pages. There is no release garbage collection; capacity/failure tradeoff is documented by the machine rather than treated as a defect without a product limit.
- **Partial website bundles:** pages and manifest are not atomic. Eviction can remove a supporting page; subsequent retention verifies manifest coverage and refetches. Offline first-use of a missing page correctly fails unavailable. No transactional guarantee is asserted.
- **Offline authorization limit:** a browser cannot observe a remote session revocation or an out-of-band cookie change while offline. Isolation is enforced on observed scope transitions/logout, not an unobservable event.
- The VM fixture models fetch, response streams, message lifetimes, cache data and client sweep, but not native install scheduling, browser quota enforcement, origin isolation or worker termination timing. Real offline navigation and session-change behavior were separately exercised by the focused PWA browser suites.

## Integration verification

All confirmed issue groups were repaired after their regression failed against
the pre-fix implementation. Controls that passed before changes are documented
as rejected hypotheses, not fixed bugs. Verification used the isolated candidate,
private data, and dynamically assigned listeners.

| Boundary | Observed result | Evidence |
| --- | --- | --- |
| Scheduler, storage, billing, executor, judging, artifact reuse | 107 focused backend tests passed | jobs, recovery, billing, generation-persistence, generation-drain, generation-viewers, executor-storage, judging, judging-runtime-artifacts, storage and artifact-reuse test files |
| OAuth and independent credential lifetimes | 8 tests passed | oauth-races, identity and manual-key test files |
| Worker session handoff, lazy initialization, owned retries, references and cancellation | 31 tests passed | service-worker-session, service-worker-initialization, service-worker-grid-retry, reference-cache, reference-cache-scope and offline-format-cutover test files |
| Affected browser surfaces | 22 mock-provider browser tests passed | creation-recovery, grid-navigation, pwa, pwa-grid-traffic, reference-recovery, image-budget, rate-limits, grid-slugs and stream-recovery-traffic spec files |
| Compilation and frontend | TypeScript check and production frontend build passed | Candidate build; only Vite configuration/dependency chunk warnings |
| Standalone executor runtime | One-shot EIO recovered in both input paths; two reads, complete, exactly one provider call and billing entry each | Real Store/Jobs/Provider and local HTTP smoke |
| Standalone scheduler runtime | Billing pause durably cleared temporary error; blocking 402 retained; reopened SQLite recovery was clean/idempotent, without extra provider calls | Real disk-backed Store/Jobs smoke |
| Standalone OAuth runtime | Held upstream exchange rejected after Disconnect; fresh explicit authorization succeeded | Real HTTP routes, provider transport and SQLite smoke |
| Standalone worker handlers | Stale handoff returned 503 without retention; Bob offline session survived delayed initialization; second transport cancelled after two reads | Shipped worker with controlled transport/CacheStorage |
| Interactive app | Two SVG cells generated, paused, reloaded paused, resumed, decoded, and remained decoded after offline reload; direct A/home/B/history-A navigation removed B title editor; billing retained three successful and two cancelled calls | External evidence directory /tmp/slopgrid-state-evidence-psCa0d, journey.json plus before/after ARIA snapshots and screenshots |
| Interactive spending confirmation | Fresh Image form with $0.50 fixture credits opened the low-balance dialog; Continue anyway remained operable and produced one saved, decoded image | External evidence directory /tmp/slopgrid-state-balance-ct8Twr, journey.json plus modal/result ARIA snapshots and screenshots |

The interactive candidate was based on `95daa2c` with the fixes present in its
source. Its built frontend hash was
73b558255be571d9b08155811d13b8c34842e7cfb9aeaa62354617ce6348e9a2.
Doctor checked each private runtime and HTTPS origin before use. Both owned
browsers and runtimes were stopped; each helper reported runtimeRemoved=true.

No production/shared deployment, real-provider suite, real GitHub sign-in,
power-loss experiment, browser quota enforcement, or exhaustively enumerated
async schedule is claimed. Tests control external providers and specific faults;
those results do not prove external provider compatibility. Remaining conditional
risks are explicitly separated from confirmed reachable application defects.
