# Product requirements: formal-verifiability report

## Executive answer

**Most of the product contract is encodable as meaningful formal propositions, but much of it is outside the creation state machine.** The main obstacles are underspecified acceptance criteria and the boundary between application behavior and external behavior, not whether a requirement is visual or implemented in TypeScript.

This audit covers PRODUCT.md at revision **ca30fbe9aa3590367de1ca1c3c5cf01c6ecf1d23**: **326 top-level numbered clauses across 39 requirement-bearing groups**, **3 additional unnumbered normative blocks**, and therefore **329 document units**. One numbered unit is a failure-scope exclusion, leaving **328 behavioral units**.

| Classification                  | Units | Interpretation                                                                                                                                                      |
| ------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D: concrete enough now          |   254 | Can be translated into objective propositions without first choosing new product policy. Explicit models, decomposition, and trust assumptions are still necessary. |
| M: mixed precision              |    71 | Contains concrete propositions, but full coverage also needs a criterion, policy, reference, or guarantee boundary clarified.                                       |
| Q: acceptance criterion missing |     3 | The stated intent has no independently grounded acceptance predicate yet. Approving metrics, assets, exact copy, or a reference would change that.                  |
| S: scope exclusion              |     1 | Defines which failures are unsupported; not itself a behavioral guarantee.                                                                                          |

**254 of 328 behavioral units are concrete enough for formalization now.** The 71 mixed units are not wholly unverifiable: their concrete subclaims can be verified immediately. The 3 Q units need acceptance criteria before a faithful whole-unit proof is meaningful.

These are **specification-readiness counts, not proof-coverage counts, implementation-correctness claims, theorem counts, or effort estimates**. A directly expressible proposition can still be false, require implementation changes, or be impossible under an unconstrained external failure model.

## Source and counting method

- Authoritative source: [PRODUCT.md](PRODUCT.md); [fixed source revision](https://github.com/klntsky/slopgrid/blob/ca30fbe9aa3590367de1ca1c3c5cf01c6ecf1d23/PRODUCT.md). This report is an assessment, not a replacement requirement specification.
- A numbered unit begins with a column-zero decimal item number under its current section. Nested bullets, indented paragraphs, and continuation paragraphs belong to that parent. The qualified reference 3.1.10 includes its entire case-editor and conversion contract, not just its first sentence.
- The two opening unnumbered section names use META.n for Website metadata and UI.n for Presentation and interaction requirements. Other references are section.item, such as 3.3.4.
- Three standalone normative blocks are included separately below. The explicitly identified high-level non-requirement product goal, document introductions, and cross-reference prose are excluded.
- Repeated requirements in different sections remain separate document units. They often share a theorem. No claim is made that there are 329 independent behaviors.
- The D/M/Q/S assignment is an explicit engineering assessment of the wording, not an objective measurement of English. D means a meaningful predicate can be written; it does not mean the English is already executable, every environmental assumption is supplied, or all reasonable readers would choose identical details.
- M is used when one part is concrete but another part needs a materially new acceptance choice. Merely needing an input type, mathematical model, induction, or browser model does not make a requirement M.
- For a mixed parent, proving one subclaim does not count as proving that whole parent. A useful implementation coverage ledger must eventually split these containers into atomic obligations with evidence.

### Additional unnumbered units

| Reference    | Source line | Class | Covered block                                                                                          |
| ------------ | ----------: | ----- | ------------------------------------------------------------------------------------------------------ |
| 2.2.footer   |         126 | M     | Define small footer-text styling; copy, link targets, separator, and grid-page exclusion are concrete. |
| 3.8.preamble |         293 | D     | Separate case/criterion operations, rubric copying, and empty YES criterion initialization.            |
| 5.3.prompt   |         406 | D     | Required SVG prompt instructions, not a guarantee that a provider follows them.                        |

The SVG-prompt block requires the application to request certain output properties. It does not say the application can prove that an arbitrary provider obeys the prompt.

## What a proposition can establish

There are three separate questions:

1. **Expressibility:** is there an objective predicate or trace property corresponding to the requirement?
2. **Provability:** does a model and implementation satisfy that predicate, under explicitly stated assumptions?
3. **Connection to the deployed program:** do codecs, extraction, compilation, effect interpreters, browser behavior, storage, and transport implement the model's operations?

The counts above answer the first question. They do not silently answer the other two. Naming an uninterpreted predicate readable or secure does not establish readability or security. Defining a specification by calling the implementation being proved is also insufficient evidence of independent product correctness.

### Safety, progress, quantitative and observational properties

- **Safety:** a bad transition never occurs. Examples include stale completions being ignored, private data not entering unauthorized responses, completed artifacts not being overwritten, and published visibility not moving backward.
- **Progress/liveness:** something eventually happens under conditions. Reconnection, recovery, scheduler fairness, and retry progress require assumptions about event delivery, clocks, storage recovery, worker release, or provider responses. Safety alone does not prove progress.
- **Quantitative:** arithmetic, limits, sums, ratios, geometry and allocation bounds. These require explicit units, rounding and numeric semantics. A mathematical-real proof is not automatically a proof about IEEE-754 operations, integer overflow or browser pixel rounding.
- **Observational equivalence:** a transformation preserves meaning, even if internal names, bookkeeping or allocation differ. This is the useful specification for ownership conversions, transpose, migration and artifact reuse.
- **Relational security:** observations or authority must not cross users, sessions, outputs or attempts. Specify protected observations and attacker capabilities; a field-projection proof is not a proof against all timing, browser-exploit or physical-memory attacks.

## Breakdown by product section

Counts include each section's additional unnumbered unit where applicable. D + M + Q + S equals Units for every row. The boundary column describes the components needed for whole-section guarantees, not a claim that all its clauses belong to one component.

| Product section                                 |   Units |       D |      M |     Q |     S | Verification boundary                                                               |
| ----------------------------------------------- | ------: | ------: | -----: | ----: | ----: | ----------------------------------------------------------------------------------- |
| Website metadata                                |       2 |       2 |      0 |     0 |     0 | Initial HTML and metadata serialization                                             |
| Presentation and interaction requirements       |      56 |      35 |     20 |     1 |     0 | Renderer, geometry, accessibility, interaction controllers; some domain projections |
| 1.1. Benchmarking model outputs                 |       8 |       6 |      2 |     0 |     0 | Form/domain semantics, inference protocol, renderer, provider contracts             |
| 2.1. Visual language                            |       6 |       1 |      4 |     1 |     0 | Theme state and renderer; approved design/asset references                          |
| 2.2. Navigation and page layout                 |      13 |       8 |      5 |     0 |     0 | Router, renderer, list protocol, session-scoped caches                              |
| 2.3. Tooltips                                   |       7 |       6 |      0 |     1 |     0 | View-model reasons, renderer, focus and pointer events                              |
| 2.4. Clipboard actions                          |       1 |       1 |      0 |     0 |     0 | Clipboard controller, browser effects, accessible rendering                         |
| 3.1. Form and output selection                  |      12 |      10 |      2 |     0 |     0 | Creation state, cell semantics, navigation, persistence, renderer                   |
| 3.2. Model and thinking-effort selection        |      10 |       9 |      1 |     0 |     0 | Selection algorithms, catalog observations, renderer                                |
| 3.3. Case inputs and variables                  |       9 |       8 |      1 |     0 |     0 | Creation state, lexical semantics, expansion, persistence, renderer                 |
| 3.4. Compatibility presentation                 |       7 |       6 |      1 |     0 |     0 | Admission/compatibility policy, provenance, renderer, server admission              |
| 3.5. Budget and automatic parallelism           |      12 |       9 |      3 |     0 |     0 | Form policy, monetary/token arithmetic, execution and provider assumptions          |
| 3.6. Inference-provider setup                   |       5 |       3 |      2 |     0 |     0 | Connection observations, credential/OAuth effects, renderer                         |
| 3.7. Image generation and attachments           |      10 |       9 |      1 |     0 |     0 | Form references, upload/cache protocol, access control, renderer                    |
| 3.8. Judged output                              |      10 |       7 |      3 |     0 |     0 | Form/rubric state, judge protocol, accounting, renderer                             |
| 4.1. Table geometry and gestures                |       9 |       6 |      3 |     0 |     0 | Layout mathematics, browser geometry, gesture controller, local storage             |
| 4.2. Title, prompt, author, and price           |       9 |       6 |      3 |     0 |     0 | Label/format algorithms, authorization projections, renderer                        |
| 4.3. Progress and actions                       |       6 |       3 |      3 |     0 |     0 | Grid lifecycle, edit/fork effects, output descriptions, renderer                    |
| 5.1. Shared controls and output preservation    |       9 |       5 |      4 |     0 |     0 | Output state, file transformations, downloads, renderer                             |
| 5.2. Markdown                                   |       7 |       5 |      2 |     0 |     0 | Escaping/parser contract, renderer, incremental views and theme propagation         |
| 5.3. Images and SVG                             |       6 |       5 |      1 |     0 |     0 | Prompt construction, repair/image rules, browser rendering/cache                    |
| 5.4. Static websites                            |       7 |       7 |      0 |     0 |     0 | Bundle/path semantics, origin isolation, streaming and browser capabilities         |
| 5.5. Thinking traces                            |       5 |       4 |      1 |     0 |     0 | Attempt ownership, streaming, durable storage, scrolling/renderer                   |
| 5.6. Judgment results                           |       9 |       8 |      1 |     0 |     0 | Result validation/scoring, artifact transport/rendering, scroll geometry            |
| 5.7. Chat history scrolling                     |       4 |       3 |      1 |     0 |     0 | Ordered area mapping, interaction state, browser geometry                           |
| 6.1. Worker allocation                          |       4 |       3 |      1 |     0 |     0 | Scheduler transition system and eligibility/fair-progress assumptions               |
| 6.2. Balance, errors, and retries               |       7 |       7 |      0 |     0 |     0 | Admission, provider error protocol, timers, recovery                                |
| 6.3. Pause, resume, and updates                 |       8 |       5 |      3 |     0 |     0 | Cancellation/recovery protocol, durable/live state, transport                       |
| 6.4. Shared generation and durable judging      |       4 |       4 |      0 |     0 |     0 | Generation grouping, workflow state, persistence/idempotency                        |
| 7.1. Per-cell and grid prices                   |       6 |       5 |      1 |     0 |     0 | Accounting algebra, availability of observations, formatting and access             |
| 7.2. Billing history                            |       6 |       6 |      0 |     0 |     0 | Call ledger, storage, ownership, pagination and renderer                            |
| 8.1. Anonymous and GitHub accounts              |       8 |       8 |      0 |     0 |     0 | Identity/ownership transitions, transactions, sessions and browser persistence      |
| 8.2. Inference credentials                      |       4 |       4 |      0 |     0 |     0 | Credential lifecycle, response projections, session/storage boundary                |
| 8.3. Publication and discovery                  |      12 |      11 |      1 |     0 |     0 | Visibility lattice, immutable publication, slug transactions, renderer              |
| 8.4. Output isolation and private access        |       5 |       5 |      0 |     0 |     0 | Authorization, browser origins/policies, private/offline cache scope                |
| 8.5. Starred grids                              |       7 |       7 |      0 |     0 |     0 | Set/ownership transitions, transactions, cross-tab protocol and renderer            |
| 9. Availability and updates                     |       5 |       4 |      0 |     0 |     1 | Deployment/drain/recovery protocol and explicit fault model                         |
| 9.1. Progressive web app and offline navigation |       9 |       8 |      1 |     0 |     0 | Service worker/cache protocol, browser lifecycle/quota, session isolation           |
| 10. Reusing completed artifacts                 |       5 |       5 |      0 |     0 |     0 | Generation equivalence, source authorization, token allowance, copying/accounting   |
| **Total**                                       | **329** | **254** | **71** | **3** | **1** | Multiple boundaries; not all creation-state properties.                             |

## How much belongs in the F* creation machine?

Section 3 has **74 numbered clauses**, or **75 units with the judged-output preamble**. Even this is not a count of clauses the current pure machine can completely prove: many combine a data invariant, storage effects, focus behavior, pointer controls and visible layout.

The current interface accepts typed drafts, explicit events, catalog data and provider observations, and returns new state, public views and commands. It is well suited to proving the following parts:

| Candidate family              | Product references                                   | Meaningful propositions                                                                                                                              | Remaining boundary                                                                                                                             |
| ----------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Ownership and cell resolution | 3.1.10; 3.3.1, 3.3.9; 3.8.9                          | One authoritative source per parameter; non-owner data cannot change a cell's resolved value.                                                        | Renderer must show the owning controls; server must use equivalent resolution semantics.                                                       |
| Meaning-preserving edits      | 3.1.4, 3.1.10, 3.1.12; 3.3.7, 3.3.9                  | Copy complete values into cases; preserve equal collapses; transpose corresponding cell meanings; preserve unrelated data.                           | UI must dispatch the intended event; persistence must serialize the same meaning.                                                              |
| Atomic loss confirmation      | 3.1.10, 3.1.12; 3.3.9                                | No draft commit before acceptance; cancellation preserves the draft; stale acceptance cannot overwrite a newer edit.                                 | Browser dialog interaction and effect execution are separate.                                                                                  |
| Variables and input isolation | 3.3.2, 3.3.4-7, 3.3.9; 3.7.3                         | Stable bindings, literal one-pass substitution, complete tokens, ordered image merging and generator/judge separation.                               | Native byte/Unicode operations and codec preservation need contracts.                                                                          |
| Admission and explanations    | 3.1.5; 3.2.3, 3.2.10; 3.4.1-7; 3.5.1; 3.6.3; 3.8.5-6 | No submission with missing required values/capabilities; no invented blocker from advisory metadata; diagnostics identify actual responsible inputs. | Catalog and connection observations are not proof of live provider truth; server remains authoritative.                                        |
| Submission lifecycle          | 3.1.8; 3.7.4; 6.2.1; 10.1                            | Captured inputs survive editing; request ownership guards completions; failure does not authorize clearing the draft.                                | HTTP, uploads, durable creation idempotency, credentials and browser storage.                                                                  |
| Additional selection intent   | 3.1.10; 3.2.4-5; 3.8.2                               | Copy-source choice, selection insertion/ranges and confirmation decisions can be pure transitions.                                                   | Some choices are React-owned today; events must carry intent/source identity instead of already-computed results for an end-to-end core proof. |

It would be misleading to turn this table into a percentage of the whole product already covered by F*. A pure state machine can prove that it emits PersistDraft or cancellation commands correctly; it cannot, by that fact alone, prove that storage completed or an upstream inference actually stopped.

Other pure algorithms are also suitable for F*, but are not creation-machine properties: worker selection (6.1), accounting folds (7.1), benchmark aggregation (5.1.9), slug/visibility transitions (8.3), scroll-mapping mathematics (5.6.7-9), and artifact equivalence/token-allowance decisions (10.2-5). Their callers and I/O need separate refinement arguments.

## Browser and visual requirements are not categorically unverifiable

Many visual requirements are straightforward propositions once a renderer and geometry model are explicit:

- Specified CSS dimensions, viewport containment, ordering, rotations, equal widths and resize clamping: UI.2, UI.4, UI.7, UI.10-12, UI.33-37 and 4.1.4-7.
- Focus, keyboard activation, accessible names, disabled states and mode exclusivity: 2.4.1, 3.2.3-5, 5.1.7-9 and 8.3.9.
- Content preservation and scroll-coordinate mappings: 5.2.2, 5.4.5, 5.6.7-9 and 5.7.1-4.
- Required copy and metadata, HTML-as-text escaping and response-field omissions: META.1-2, 5.2.1, 7.2.5 and 8.2.4.

A proof about computed boxes or a view description must still connect to React, CSS, browser layout/paint, font metrics, focus and input handling. Checking a screenshot or running Playwright provides concrete conformance evidence, not a universal proof over every viewport and event history. A verified view-model function alone does not prove the resulting pixels.

For colors, typography, motion and assets, an approved versioned reference can turn a currently qualitative requirement into an exact relational requirement. It must be a product-approved reference, not an arbitrary snapshot of whatever the implementation happens to produce. Matching a reference does not prove that people find it readable or recognizable.

## External behavior and limits on unconditional guarantees

### Providers and monetary budgets

The application can prove request construction, token-limit calculations, routing constraints, fallback selection, reported-charge aggregation and nonnegative remaining allowance. A bound on **actual provider charges** additionally needs trustworthy price bounds, token accounting, rounding rules and provider compliance. Local arithmetic cannot force an external provider to honor an advertised price or token allowance.

This distinction matters for **3.5.3 and 3.5.12**: a requested-token bound and a real-money bound are different theorems. The monetary assurance in the required pipeline warning needs an explicit guarantee boundary; this audit does not silently reinterpret it as only a token-limit claim. Likewise, preserving reported costs does not prove that reported costs equal an eventual invoice.

Judgment order, schema validation, expected-answer isolation and score computation are formalizable. A schema-valid model verdict is not a proof of the truth of an arbitrary natural-language criterion. The report does not infer semantic judgment accuracy from 5.6.4.

### Cancellation, retries and exactly-once effects

An application can prove that cancellation is requested, future dispatch stops, stale replies are rejected, and completed work survives. That is not automatically a guarantee that remote computation stops immediately or ceases incurring charges.

Creation replay (1.1.8), workflow retry safety (6.4.3-4) and no-duplicate-charge recovery (9.4) require a precise crash/network/storage model. If a remote service can accept a non-idempotent request and the acknowledgment can be lost, unconditional exactly-once effects plus unrestricted retry progress cannot be obtained from local state alone. Provider idempotency, reconciliation or a narrower failure model may be necessary. This is a feasibility condition to examine, not evidence that the current implementation satisfies or violates those requirements.

### Fairness, recovery and platform capabilities

Scheduler safety can bound new dispatch and choose a least-allocated eligible user. Eventual service additionally needs assumptions about eligibility, worker release, arrival patterns and scheduling fairness. Existing active work may legitimately exceed a newly lowered limit while draining under 6.1.4; the safety predicate must constrain new dispatch rather than incorrectly require the new cap retroactively.

Recovery and retention require supported storage behavior and an explicit persistence boundary. Browser retention is subject to quota, eviction and lifecycle rules. Permission-gated APIs, installation, cross-origin rules and live generated-site capabilities remain subject to the browser; several product clauses already state these conditions explicitly.

No-application-limit clauses can express the absence of business-policy caps over finite representable inputs. They cannot establish infinite RAM, storage, response sizes or provider capacity. The supported fault model also explicitly excludes disk-full recovery in 9.5.

### Security

Ownership transitions, publication monotonicity, response projections, credential scope and origin allocation can be specified precisely. End-to-end isolation also assumes the relevant browser-origin/CSP mechanisms, authentication/cryptographic primitives and deployment configuration implement their contracts. State proofs do not replace those boundaries or imply protection against every possible browser exploit, timing channel or physical-memory observation.

## Complete clarification and exclusion index

Every numbered clause not listed here is D. This complement rule, the 39 section totals, and the source revision make every numbered classification auditable without pretending each parent is one atomic theorem. The additional unnumbered footer block is M; the other two unnumbered units are D.

For each M entry, the text identifies a concrete part that can be verified before the missing criterion is decided. Q does not mean fundamentally impossible; it means the present wording does not yet fix a faithful acceptance predicate. Proposed clarifications are recommendations, not changes to PRODUCT.md.

| Requirement | Class | Missing criterion or scope; concrete part where applicable                                                                                                                  |
| ----------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI.1        | M     | Define readable/normal content widths and page gutters; viewport containment and local overflow are concrete.                                                               |
| UI.3        | Q     | Approve numeric light/dark palette tokens or a versioned design reference; color descriptions alone do not define acceptance.                                               |
| UI.9        | M     | Freeze the established button reference and matching dimensions; borderless secondary actions are concrete.                                                                 |
| UI.13       | M     | Approve the selected-state tinted-fill and reinforced-outline reference; selection-dependent styling is concrete.                                                           |
| UI.14       | M     | Define small/muted numbering styles; numbering and separator placement are concrete.                                                                                        |
| UI.17       | M     | Freeze the established results-panel typography and spacing; input containment is concrete.                                                                                 |
| UI.20       | M     | Specify which alignment edges or centers must coincide; rotation and responsive orientation are concrete.                                                                   |
| UI.22       | M     | Version the previous preview size and define compact removal controls; order and accessible names are concrete.                                                             |
| UI.23       | M     | Version the previous Chat presentation and compact layout tokens; editor transitions, labels, and focus rules are concrete.                                                 |
| UI.28       | M     | Specify small/muted typography tokens; 28px padding and 320px selector sizing are concrete.                                                                                 |
| UI.29       | M     | Version the established title/prompt positions and spacing; relative typography roles can be checked.                                                                       |
| UI.32       | M     | Specify the tolerance for approximately 35px; alignment and exact padding are concrete.                                                                                     |
| UI.36       | M     | Define muted action styling; footer dimensions, padding, icons, and ordering are concrete.                                                                                  |
| UI.38       | M     | Define toolbar clearance and the typography baseline; padding and table sizing rules are concrete.                                                                          |
| UI.45       | M     | Version established grid-list row spacing; icon/title/status ordering is concrete.                                                                                          |
| UI.47       | M     | Specify small/muted introduction styles; omission when the count is zero is concrete.                                                                                       |
| UI.48       | M     | Version the original tooltip allowlist; exclusions and copy-state behavior are concrete.                                                                                    |
| UI.50       | M     | Version preserved phone spacing; title wrapping and prompt ellipsis rules are concrete.                                                                                     |
| UI.54       | M     | Define muted drag-handle styling; press/drag/drop transitions and destination-gap selection are concrete.                                                                   |
| UI.55       | M     | Define large confirmation-button sizing; the five-word threshold and confirmation/dismissal transitions are concrete.                                                       |
| UI.56       | M     | Approve error/warning palette and stripe geometry; exact symbols and component reuse are concrete.                                                                          |
| 1.1.3       | M     | Approve subtle system-message tint and the referenced existing presentation; history, blank filling, attachment, and usage rules are concrete.                              |
| 1.1.6       | M     | Define sensible rate-limit policy; absence of application inference deadlines is concrete.                                                                                  |
| 2.1.1       | M     | Specify dim/warm palettes; System/Light/Dark selection, persistence, and toggling are concrete.                                                                             |
| 2.1.3       | M     | Define the allowed license set and approved brand assets; recognizable appearance needs a reference or human judgment.                                                      |
| 2.1.4       | M     | Define restrained/excessive border and radius criteria; consistency and secondary-border absence are concrete.                                                              |
| 2.1.5       | Q     | Define concision and information-level distinctness or approve exact copy; string inequality alone would not establish the stated intent.                                   |
| 2.1.6       | M     | Freeze the external polygon-animation reference; direction and unsupported-platform fallback are concrete.                                                                  |
| 2.2.footer  | M     | Define small footer-text styling; copy, link targets, separator, and grid-page exclusion are concrete.                                                                      |
| 2.2.2       | M     | Specify readable text metrics and matching gap references; uppercase labels and equality of the specified gaps are concrete.                                                |
| 2.2.7       | M     | Define a prompt 404 response as a latency bound or event-order guarantee; absence of retries is concrete.                                                                   |
| 2.2.8       | M     | Define small connection-label styling; recovery, authorization, offline handling, and layout preservation are concrete.                                                     |
| 2.2.12      | M     | Define the prefetch/readiness window; initial data, state reuse, and user isolation are concrete.                                                                           |
| 2.3.2       | Q     | Define the permitted non-obvious action set; an unconstrained predicate called non-obvious would be a vacuous specification.                                                |
| 3.1.10      | M     | Define compact/quiet/normal presentation references; ownership, conversions, case copying, and confirmation behavior are concrete.                                          |
| 3.1.12      | M     | Define untouched-form detection independently of the implementation; compatible-value preservation and atomic confirmation are concrete.                                    |
| 3.2.8       | M     | Define catalog freshness/currentness; initial catalog availability can be stated by event order.                                                                            |
| 3.3.2       | M     | Define compact image-file-chooser presentation; variable naming, reference rewriting, and editor structure are concrete.                                                    |
| 3.4.3       | M     | Define compact compatibility-table presentation; actual-intersection aggregation and Mixed/absent semantics are concrete.                                                   |
| 3.5.2       | M     | Define compact budget-field dimensions; label, icon containment, and parameter ownership exclusions are concrete.                                                           |
| 3.5.3       | M     | Define conservative input estimation and price/routing assumptions; token-limit arithmetic and missing-metadata branches are concrete.                                      |
| 3.5.4       | M     | Specify the conservative estimate and parallelism recommendation policy; automatic selection and judge-budget separation are concrete.                                      |
| 3.6.1       | M     | Specify compact connection-row geometry; location, heading, and single provider identity are concrete.                                                                      |
| 3.6.2       | M     | Define less-prominent Change connection presentation; connected/disconnected actions are concrete.                                                                          |
| 3.7.6       | M     | Specify small thumbnail geometry; name precedence, field order, and expansion behavior are concrete.                                                                        |
| 3.8.1       | M     | Define slightly larger checkbox styling; initialization, supported formats, section order, and scroll anchoring are concrete.                                               |
| 3.8.2       | M     | Version the referenced role-switch badge and shared chat deletion-control presentation; criterion values, ordering, confirmation, and last-criterion behavior are concrete. |
| 3.8.3       | M     | Identify/version the existing judging instructions used for initialization; ownership, omission, selector behavior, and labels are concrete.                                |
| 4.1.2       | M     | Define readability criteria; 90-degree rotation and content fitting are concrete.                                                                                           |
| 4.1.3       | M     | Define compact/restrained header sizing; independent output-cell sizing is concrete.                                                                                        |
| 4.1.8       | M     | Define usable gesture handling criteria; axis routing and excluding navbar zoom are concrete.                                                                               |
| 4.2.1       | M     | Define character counting/truncation units, including code points versus grapheme clusters; expansion order, filename fallback, and title independence are concrete.        |
| 4.2.3       | M     | Define the title character-counting unit; a 40-unit limit and no ellipsis are then precise.                                                                                 |
| 4.2.4       | M     | Specify dark title color for the light theme; dark-theme white and accent equality are concrete.                                                                            |
| 4.3.1       | M     | Specify thin progress-bar height; completed/failed counting and segment state are concrete.                                                                                 |
| 4.3.3       | M     | Version compact shared action styling; action ordering and icon-only controls are concrete.                                                                                 |
| 4.3.4       | M     | Define immediate cancellation at the application versus provider boundary; setup restoration and new-grid identity are concrete.                                            |
| 5.1.3       | M     | Define filename portability, normalization, and disallowed character policy; the filename component order is concrete.                                                      |
| 5.1.4       | M     | Specify the allowed SVG repair rewrite system; verbatim Markdown and preservation outside repairs are concrete.                                                             |
| 5.1.7       | M     | Define the visibly recessed pressed-state reference; mode exclusivity and source-view behavior are concrete.                                                                |
| 5.1.9       | M     | Define compact bottom-switcher geometry and the referenced recessed treatment; aggregation, mode persistence, and chart calculations are concrete.                          |
| 5.2.1       | M     | Approve the typography/spacing/style reference; raw HTML escaping is concrete.                                                                                              |
| 5.2.3       | M     | Specify the font and natural line-spacing reference; equal glyph advances, scaling, and source font sharing are concrete.                                                   |
| 5.3.2       | M     | Specify the SVG repair system referenced from 5.1.4; requiring consistent streaming repair does not itself define the allowed rewrites.                                     |
| 5.5.2       | M     | Specify fixed readable font metrics; raw wrapping, scrolling, mode switching, and no content-fit scaling are concrete.                                                      |
| 5.6.5       | M     | Specify the font/resource rendering baseline; request ordering, artifact preservation, render bounds, and failure handling are concrete.                                    |
| 5.7.3       | M     | Specify very subtle comparison tint; matching-message selection and streaming propagation are concrete.                                                                     |
| 6.1.2       | M     | Define the fairness objective and eligibility/fair-progress assumptions; choosing a minimum-active-worker user at dispatch is concrete.                                     |
| 6.3.1       | M     | Define immediate cancellation and the provider acknowledgment boundary; queue removal, completed-output preservation, and storage-independent cancellation are concrete.    |
| 6.3.4       | M     | Define when stopping authorized live progress is necessary; durable-versus-live state and deny-on-unknown-authorization are concrete.                                       |
| 6.3.7       | M     | Define recovery-storage bounds, retry-throttle policy, and prefer-resume criteria; deltas, fallback snapshots, and viewer isolation are concrete.                           |
| 7.1.2       | M     | Specify the streaming usage estimator or its required error envelope; aggregate availability, replacement, and approximate labeling are concrete.                           |
| 8.3.12      | M     | Specify compact validation presentation; control grouping, focus, wrapping, and removal of extra message spacing are concrete.                                              |
| 9.5         | S     | Failure-model exclusion: disk-full recovery is not promised; this is a scope constraint, not a behavioral theorem.                                                          |
| 9.1.8       | M     | Define aggressive image-cache policy; account scoping, authorization rechecks, unchanged-byte reuse, and logout clearing are concrete.                                      |

## Verification strategy and priorities

1. **Keep the specification independent.** Define cell meaning, admission, ownership and loss separately from reducer helper calls. Then prove that actual transitions refine those definitions. Do not weaken transpose to cell-count equality or assume the desired rename/expansion equality.
2. **Prove initialization and transition preservation.** Separate structural state validity from submission eligibility. An unfinished draft is legitimate; it should not be forced to meet generation admission. Include all explicitly dispatchable events, not only those a particular UI path currently emits.
3. **Finish the recommended form batch first:** exclusive ownership, value-preserving ownership conversion, semantic transpose and atomic confirmation. These protect user-entered data and share the cell-meaning specification.
4. **Add admission and provenance next.** Cover blocking versus advisory feedback, per-cell capabilities, endpoint-combination witnesses, raw budget edits, image-budget exceptions and explicit model selection.
5. **Verify the effect boundaries separately.** Use a protocol/storage model for creation idempotency, uploads, success acknowledgment, durable state and recovery. Use event/geometry models for rendering, focus and interaction. Connect each model to the real implementation rather than treating tests as proof.
6. **Prioritize high-consequence backend invariants:** authorization/session isolation, publication and slug transaction atomicity, billing conservation, worker ceilings, generation deduplication and artifact reuse equivalence.
7. **Resolve acceptance choices before aesthetic proofs.** Freeze palette, typography, layout/animation references, latency meanings, estimation policies and the external monetary guarantee boundary. Do not obtain easy proofs by inventing arbitrary thresholds.

A future coverage ledger should identify an atomic obligation, its source clauses, independently defined predicate, implementation entry point, theorem or counterexample, assumptions, and remaining codec/effect/rendering gap. Count a compound requirement as fully covered only when every obligation and required boundary connection is accounted for.

## Current proof-status boundary

This report audits **potential formalization**, not implementation proof coverage. At the audited baseline, normal F* checking and selected lifecycle/refinement lemmas are available; they are not evidence that all D units are proved. The ongoing ownership, conversion, semantic-transpose and confirmation work must be evaluated from its actual checked theorem statements and preconditions. It is deliberately not counted as completed product coverage here.

Report checks: all 326 numbered source clauses are assigned exactly one D/M/Q/S class; the three additional blocks are explicit; section counts and totals reconcile; no source requirement text was changed. Documentation-only analysis does not require running application test suites.
