# F* creation-machine performance compared with TypeScript

Measured on 2026-11-05 against source revision `b4d089f0054ade35a224e1ca34bf63fe540dbd12`.

## Conclusion

The current extracted F* implementation is substantially slower than TypeScript when rebuilding a grid's complete form view. The smallest form is cheap in both implementations. Larger grids and chat histories make the difference large enough to matter on the browser's main thread, before React renders anything.

There is also a concrete runtime failure. On a one-cell form, long prompts accepted by the TypeScript implementation make the F* view overflow the JavaScript stack. This deserves fixing before treating the extracted implementation as a replacement with the same practical input limits.

This is a report on the current implementation, not a benchmark of F* as a language. No application code or default implementation changed during this investigation.

## What was measured

The comparison calls the real `typescriptCreationMachine` and `fstarCreationMachine` public APIs. F* timings include the production host adapter and its codecs. They do not bypass validation to give the extracted implementation a cheaper interface.

[create-controller.ts](src/create/create-controller.ts) calls `update`, then `view` whenever state changed, then publishes the result and executes commands. The typing, budget and transpose measurements therefore include update plus view. The measurements exclude React, DOM work, local-storage persistence, uploads, backend requests and provider execution. They are machine costs, not measured end-to-end input latency.

Seven synthetic fixtures were checked against both implementations before timing. They produced equal initial views and equal outcomes, commands and views through budget editing, prompt editing, two swaps and a stale callback. Each initial fixture was submit-eligible. This validates the measured workloads, not general TS/F* equivalence.

The ordinary fixtures have one variable field on each axis, a shared Markdown prompt, a shared text model and a 256-entry catalog. The selected model is last. The chat fixture has eight messages, images referenced by user messages, and two judge criteria. The 48x48 case is a stress workload, not a recommendation for a usable form size. Catalog-size variants use one and 1,024 entries.

The ordinary baseline prompt is 66 ASCII characters. Typing replaces the first message with a 240-character prompt that still references both axes; successive values differ in one character. Budget values alternate between 3 and 4. These edits alternate across sample boundaries and assert that state changed, so slow one-iteration batches cannot accidentally measure no-ops. Repeated swaps keep the workload bounded.

Each row is the median of seven batch-average costs after adaptive warmup. A warmup batch reaches at least 75 ms unless it hits 65,536 iterations. Backend order alternates between workloads. These are not individual-event p50 or p95 latencies.

The host was Linux x64 on an Intel Xeon E-2236 at 3.40 GHz, with 12 logical CPUs and about 31 GiB RAM. Chromium was `150.0.7871.24`, unthrottled. Node was `v24.22.1`. Node and Chromium sampling ran separately. CPU frequency, unrelated host load and garbage collection were not controlled.

## Browser results

Chromium ran production-minified bundles built with Vite 8.3.4, targeting ES2022. All values below are milliseconds per call or update-plus-view.

| Fixture | TS view, ms | F* view, ms | TS typing, ms | F* typing, ms | Typing F*/TS |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1x1 | 0.058 | 0.171 | 0.112 | 0.406 | 3.6x |
| 8x8 | 0.525 | 4.434 | 0.685 | 11.650 | 17.0x |
| 24x24 | 4.066 | 44.000 | 4.622 | 111.500 | 24.1x |
| 48x48-stress | 16.375 | 215.300 | 18.425 | 484.200 | 26.3x |
| 8x8-chat-judge-images | 3.984 | 111.700 | 4.328 | 101.700 | 23.5x |

Here, `view` uses the initial fixture. Typing uses the longer replacement prompt. Subtracting the initial view cost from typing would therefore not isolate reducer overhead. In the chat fixture, the replacement first message is shorter than the original, so its typing result can be cheaper than the original view.

Budget editing and transpose use the original prompt size and include the resulting view:

| Fixture | TS budget, ms | F* budget, ms | TS transpose, ms | F* transpose, ms |
| --- | ---: | ---: | ---: | ---: |
| 1x1 | 0.104 | 0.277 | 0.124 | 0.287 |
| 8x8 | 0.654 | 5.225 | 0.680 | 4.988 |
| 24x24 | 4.278 | 51.850 | 4.409 | 44.700 |
| 48x48-stress | 17.175 | 253.900 | 17.075 | 223.800 |

At 60 Hz, an entire frame has about 16.7 ms. Several F* workloads exceed that allowance in machine work alone. The stress fixture also exceeds it on TypeScript. Actual React and browser rendering costs would be additional; they were not measured here.

Initialization includes validating and retaining the catalog, but not importing the module. Initialization plus view is measured separately rather than adding independent medians:

| Fixture | TS init, ms | F* init, ms | TS init + view, ms | F* init + view, ms |
| --- | ---: | ---: | ---: | ---: |
| 1x1 | 0.809 | 8.275 | 0.895 | 9.581 |
| 8x8 | 0.862 | 9.031 | 1.536 | 14.900 |
| 24x24 | 0.952 | 10.700 | 5.325 | 59.750 |

Even the one-cell initialization contains the full 256-entry catalog. The catalog is retained in opaque state afterward; it is not serialized again on every event.

### Reducer work is not the main repeated cost

The Node run measured updates without requesting a view. It used the same source and fixtures, through `tsx` rather than the browser's minified bundle. These numbers are diagnostics, not estimates of Chromium update time.

| 24x24 operation in Node | TS, ms | F*, ms |
| --- | ---: | ---: |
| budget-update | 0.191 | 0.324 |
| prompt-update | 0.193 | 0.378 |
| transpose-update | 0.207 | 0.312 |
| stale-callback | 0.023 | 0.041 |
| prompt+view | 5.960 | 54.531 |

The updates are much cheaper than update plus a complete view. The Node/browser difference is also substantial, so there is no single portable slowdown factor. Browser results should guide frontend decisions.

## Where the time goes

### The JSON bridge has a cost, but host decoding is not the whole problem

[src/create/machine-wire.ts](src/create/machine-wire.ts) validates and JSON-encodes incoming DTOs and parses and validates returned DTOs. [Creation_Bridge.ml](formal/ocaml/Creation_Bridge.ml) parses that JSON with Yojson, validates it into typed F* records and variants, and serializes commands and views back out. The F* state itself is typed and stays behind an opaque handle. It is not an unparsed JSON document.

Every changed draft normally also returns a persist-draft command containing the draft. Every view returns the draft and the complete expanded compatibility-cell list. This makes bridge work depend on the amount of returned data, not merely the event's size.

The following measurements separate some of the work:

| Chromium measurement | 8x8, ms | 24x24, ms |
| --- | ---: | ---: |
| TS public view | 0.525 | 4.066 |
| TS through both wire adapters | 1.336 | 11.325 |
| F* public view | 4.434 | 44.000 |
| F* generated view + JSON encoding | 4.325 | 44.600 |
| Host decode of cached F* view JSON | 0.330 | 2.622 |

The generated-view row still includes policy evaluation, the OCaml-compatible runtime, construction of the JSON value and JSON encoding. It is not pure reducer or policy time. The decode row repeatedly parses one cached JSON string, which can behave differently from freshly constructed strings. Independent medians need not add up; one generated-view median even exceeds its public-view median.

The TypeScript wire control uses the existing adapters in both directions around the real TypeScript machine. It shows that a JSON interface is expensive even without F*. It does not reproduce the OCaml representation or Yojson encoder, and it does not prove how much time a different F* bridge would save.

### Every changed event rebuilds all cell previews

Both implementations reevaluate admission and compatibility in `view`. The F* path is explicit in [Slopgrid.Machine.fst](formal/Slopgrid.Machine.fst), lines 572-581, and [Slopgrid.Policy.fst](formal/Slopgrid.Policy.fst), lines 16-93. No previous policy result is cached there. Template expansion, capability checks and preview construction run again, even after a budget edit.

The returned view duplicates expanded messages across cells. For these ASCII fixtures, the public view serialized with `JSON.stringify` has these sizes. The draft column includes its small initialization envelope and excludes the catalog:

| Fixture | Draft input envelope, bytes | Complete view JSON, bytes |
| --- | ---: | ---: |
| 1x1 | 626 | 1,258 |
| 8x8 | 1,977 | 28,628 |
| 24x24 | 5,149 | 245,272 |
| 48x48-stress | 9,925 | 972,640 |
| 8x8-chat-judge-images | 7,988 | 521,615 |

Those are representation sizes, not network transfers or heap measurements. Still, they explain why a tiny input event can trigger substantial serialization and allocation work.

### The extracted implementation does more repeated searching

[Slopgrid.PolicyCompatibility.fst](formal/Slopgrid.PolicyCompatibility.fst), lines 18-25, searches the catalog as a list. It searches the tail before testing the head to retain the last matching entry, so it traverses the catalog even when a match is near the beginning. Each cell resolves its model, and judged cells resolve a judge model too. Alias resolution also uses list searches.

TypeScript builds a catalog `Map` once per compatibility analysis and caches alias resolution. See [grid-compatibility.ts](server/grid-compatibility.ts), lines 139-160, and [model-alias.ts](server/model-alias.ts).

The catalog-size measurements show this cost without making it the only explanation:

| Catalog entries, 8x8 fixture | TS view, ms | F* view, ms |
| --- | ---: | ---: |
| 1 | 0.576 | 4.413 |
| 256 | 0.525 | 4.434 |
| 1024 | 0.573 | 5.650 |

The F* path remains much slower with a one-entry catalog. Catalog indexing alone will not remove the overall difference.

[Slopgrid.PolicyVariables.fst](formal/Slopgrid.PolicyVariables.fst), lines 23-115, also searches variable-name lists, walks case lists to reach a coordinate, and deduplicates images using list membership. Its `interpolate` function scans the original template one byte at a time and recursively concatenates the result. TypeScript uses an indexed variable map, array indexing, regular-expression matching and image-ID sets in [prompt-variables.ts](server/prompt-variables.ts).

For fixed template size, the repeated F* model-lookup component alone grows with cell count times catalog size. Its repeated coordinate lookups add dependence on row and column lengths. The corresponding TS catalog work builds one map and then looks up each cell. These are source-backed algorithm differences. The measurements do not assign an exact percentage of the slowdown to each one.

## What the generated JavaScript actually contains

The inspected file was `src/create/fstar/creation-machine.generated.js`, generated by F* 2026.10.25, OCaml 4.14.2 and js_of_ocaml 6.0.1. `pnpm creation:check` confirmed that the artifact matches the current source fingerprint `67fbbff1332545de5fde244c319dc9911e3395d4d88bf192b2fa7a04be1371bd`. Its SHA-256 is `6c30d68bc22e97d9d010cba082ad4b453ff5bc274e6ce70030ec8137f3cef72d`.

Lists use OCaml-style cons blocks such as `[0, head, tail]`, rather than indexed JavaScript arrays. For example, the emitted append helper at lines 4167-4171 is:

```js
function _s_(_aNq_, _aNp_) {
  if (!_aNq_) return _aNp_;
  var _aNr_ = _aNq_[1];
  return [0, _aNr_, _s_(_aNq_[2], _aNp_)];
}
```

Appending copies the left list's cons blocks and retains recursive JavaScript calls. Other emitted traversals are loops, so it would be wrong to say every F* recursion consumes the JS stack. Tagged values and list blocks nevertheless add allocations and indirections compared with direct JS records, arrays and maps. Their GC cost was not separately profiled.

The runtime includes structural equality, OCaml string operations, Yojson and arbitrary-precision integer support. Important qualifications:

- Small integer addition and subtraction have native-number fast paths at generated lines 9074-9090. They fall back to BigInt-backed operations on overflow or large values. It is not accurate to blame every counter operation on BigInt.
- Budgets use the native float representation in [Slopgrid_Number.ml](formal/ocaml/Slopgrid_Number.ml), not arbitrary-precision decimal arithmetic.
- The generated header says `use-js-string=true`. Native bindings still enforce OCaml byte-oriented length, slicing and token offsets; they are not interchangeable with JS UTF-16 offsets.
- State handles use a frozen object and a WeakMap. They do not serialize or deep-copy the entire retained state on each update.
- Proof checking happens during generation, not during form events. The browser runs compiled JavaScript, not the F* prover or an OCaml bytecode interpreter. The theorem count is not a per-event cost.

## Long prompts expose a stack failure

On a 1x1 fixture with a one-entry catalog, replace the first message with:

```js
"Compare $ROW1 with $COLUMN1. ".padEnd(length, "x")
```

| Prompt length | TypeScript in Chromium | F* in Chromium | Node observation |
| ---: | --- | --- | --- |
| 1,000 | Not probed | Not probed | Both return submit-eligible views |
| 10,000 | Returns a submit-eligible view | Initializes, then view throws RangeError | Same outcome as Chromium |
| 100,000 | Returns a submit-eligible view | Initializes, then view throws RangeError | Same outcome as Chromium |

The error is `Maximum call stack size exceeded`. Chromium's stack repeatedly names the generated recursive function `LP`. These were single probes at each length, not a search for an exact failure threshold. The per-probe elapsed times are not used as performance samples.

F* totality proves termination under its model. It does not prove that a finite computation fits the JavaScript engine's call stack. The generated-path failure is observed; identifying every affected recursive path would require further investigation.

## Download and module startup costs

The controlled production builds below include each machine's transitive dependencies. They use Vite normal production ES output with preserved entry exports, minification enabled, no external modules and no source maps. They are machine-entry bundles, not whole-application bundles. Compression was performed offline with Node zlib.

| Production-minified entry | Raw bytes | gzip level 9 | Brotli quality 11 |
| --- | ---: | ---: | ---: |
| TypeScript only | 154,183 | 44,306 | 39,205 |
| F* with host adapter | 356,682 | 111,575 | 94,544 |
| Current eager machine selector | 386,123 | 120,387 | 102,097 |

[machine-selection.ts](src/create/machine-selection.ts) imports both implementations eagerly. Choosing TypeScript changes which machine handles events but does not currently avoid loading the F* runtime. The combined row accounts for shared dependencies; summing the separate entries would double-count them. These sizes do not establish which compression the deployed server actually uses.

Seven fresh browser contexts per entry and import mode produced these module-import medians:

| Import mode | TypeScript, ms | F*, ms |
| --- | ---: | ---: |
| Direct import from loopback server | 30.7 | 40.3 |
| Import after fetching the entry body | 29.0 | 40.1 |

These are import timings, not pure parsing or evaluation timings. Resource Timing returned no entries, so cache reuse in the prefetched mode could not be independently verified. Direct import includes local raw-byte transfer. Both modes reuse the browser process and OS caches; neither measures a cold browser launch or a user's network.

## What I would fix first

1. Make the prompt-processing paths stack-safe without truncating or rejecting otherwise supported input. The long-prompt failure is a correctness issue, not just a slower implementation.
2. Profile the generated policy, template scanner and JSON encoder separately. The current measurements locate the expensive work before host decoding but do not distinguish those components well enough to choose one rewrite with confidence.
3. Stop rebuilding unchanged expanded messages after budget or metadata edits. Keep eligibility and budget fields current; a cached result must not admit a stale draft. Preserve the public contract that returned DTOs cannot alias retained state.
4. Replace repeated catalog, variable-name and coordinate list searches with indexes or verified indexed structures. Preserve last-entry lookup behavior, alias handling and missing-field results. The one-entry-catalog result shows this is only part of the work.
5. Reduce repeated conversion of the complete view across the JS/OCaml boundary. A typed direct-object bridge or smaller typed view updates are candidates, but validation and ownership guarantees must remain. The isolated rows do not justify a promised speedup.
6. Load only the selected implementation before mounting the form. That addresses payload and startup costs, not the full-view CPU problem.

None of these changes is implemented by this report.

## Evidence and limits

There are 142 Node timing rows and 72 successful Chromium timing rows, each with seven batch samples, plus 28 fresh-context import samples. Initial fixtures and the measured edit traces were compared across both machines. The admitted long-prompt probes failed on the extracted implementation in both runtimes.

Raw samples, temporary runners, bundles and inspection notes remain under ignored `.data/fstar-performance/` in the analysis worktree. Node ran with `pnpm exec tsx .data/fstar-performance/node-run.ts`; the browser bundle used `node .data/fstar-performance/browser-build.mjs` and a static service bound to loopback port zero. The browser imported its benchmark module and called the shared measurement functions. These temporary files and generated JS are deliberately not committed.

An initial browser setup pass used the wrong evaluation realm and never invoked a benchmark. Its setup errors were excluded from the timing results and retained separately. An early whitespace-preserving ES-library build was also discarded. All browser numbers here use the corrected production-minified build.

No React render measurements, allocation profiles, GC traces, mobile runs, other browser engines, CPU-throttled runs or real-provider calls were performed. No unit or E2E suite was rerun for this report-only change. Synthetic ASCII text and compatible model metadata do not cover every draft, Unicode input, alias chain, image setting or failure path. The measurements establish the costs and failures above, not a universal slowdown factor or a complete memory profile.
