# Slopgrid requirements

This document defines Slopgrid's product behavior and user experience.

See [README.md](README.md) for an introduction, [ARCHITECTURE.md](ARCHITECTURE.md) for architecture constraints and implementation, and [DEVELOPMENT.md](DEVELOPMENT.md) for development and validation guidance.

## 1. Product

### 1.1. Benchmarking model outputs

1. Slopgrid lets people submit a prompt and compare generated outputs in a two-dimensional grid whose row and column meanings they choose.
2. Support exactly three axis types: models, thinking effort, and prompt variables.
3. Offer four output types in this order: Markdown, Image, SVG, and Static website. Image generation uses image-capable models; static websites may contain multiple files but no server-side code.
4. Generate outputs on the server, stream progress to the browser, retain completed results, and let owners publish their grids afterward.
5. A cell attempt makes one inference call.
6. Apply sensible request and generation rate limits without imposing deadlines on accepted inference.

## 2. Interface, navigation, and presentation

### 2.1. Visual language

1. Use a dim, slightly warm light theme and a subtly warm dark theme. Settings offers System, Light, and Dark; System is the default and follows system appearance.
2. Use the custom 5x5-cell SVG project mark. Place it to the left of the website name, and give the word "grid" the same accent color as the logo squares.
3. Use permissively licensed stock interface icons alongside official OpenRouter and GitHub brand assets. Brand icons must remain recognizable and uncropped.
4. Keep buttons consistent throughout the interface, with restrained borders, padding, and corner rounding. Output-type cards should have larger icons and labels without excessively rounded corners.
5. Use concise, distinct headings and labels without repeating information already visible in the section.

### 2.2. Navigation and page layout

1. The logo opens `/grids` and serves as the navbar's grid-list link. Put the prominent NEW GRID action, with a plus icon, on the grid-list page.
2. Keep navbar link labels uppercase, with readable desktop text and enough space for grid information. Use matching gaps between the brand, action buttons, and title/prompt group.
3. On mobile, move navigation into a hamburger menu anchored close to its button. Keep compact grid action buttons on the first navbar row where they fit.
4. Give "Your grids" and "Public grids" matching large heading styles. Keep separators only between grid entries in the lists.
5. Billing and Settings use the same wider page-layout approach as `/grids`.
6. Publication state is conveyed through the available grid actions and placement in the public list.
7. A missing grid should show its 404 promptly without retrying. Keep the error message focused on the missing grid.
8. Connection loss appears as a small bottom-right label with a rotating preloader and must not shift page layout. Generation preloaders must visibly spin.

### 2.3. Tooltips

1. Tooltips have consistent behavior and a pitch-black background with white text in both themes.
2. Use hints only to explain a non-obvious action, icon, or value, consistently across the frontend.
3. Explain Model default as "Uses the model's default thinking settings." Explain the budget as "Used to calculate each output's token limit." Use the cost and spent hints specified in section 7.1.
4. Give token-arrow indicators "Input tokens" and "Output tokens" hints. Supported compatibility checkmarks do not get tooltips.
5. Budget and parallel-worker hints use the same field-level interaction.
6. Use the current pause hint and parallel-worker hint specified in sections 3.5 and 6.3.

## 3. Grid creation

### 3.1. Form and output selection

1. The creation-page call to action is "Create your own AI model benchmark".
2. Selecting an output type reveals all remaining form sections immediately, while keeping the output choice visible.
3. Preserve the in-progress setup through provider authorization and restore the applicable setup when editing or forking.
4. Put an icon-only swap button between the row and column selectors. It has no border and swaps axis types, selected values, and corresponding prompt-variable references together.
5. Checkbox lists start unselected. Every generation must use an explicitly selected model, including when model is a fixed setting rather than an axis.

### 3.2. Model and thinking-effort selection

1. Model lists are filterable and alphabetically ordered, with a tall selection area that makes multiple options visible at once.
2. The filter has a magnifying-glass icon, the placeholder "Search models," and an always-visible clear cross.
3. Initialize the model search to an empty string for Image and to `latest` for every other output type. This filter must not select a model automatically.
4. Show selected models as removable badges under the model list, including selections currently hidden by the filter.
5. Shift-click selects or clears a range of visible model checkboxes according to the clicked checkbox's new state.
6. Use the term "thinking effort." Order efforts by their semantic levels rather than alphabetically or by selection order, and let the effort selector expand to its full content height without an inner scrollbar.
7. A model or effort that is not an axis applies as a fixed selection to the grid. Keep "Model default" thinking distinct from automatic model selection: the former leaves the model's thinking configuration unspecified.

### 3.3. Prompt variables

1. Use `$ROW` and `$COLUMN` for literal substitution of the corresponding prompt-variable values.
2. Support either or both axes as prompt variables, using the values supplied for each axis to expand the grid.
3. Each enabled prompt variable must occur in the prompt before generation can start.
4. Show variable guidance only when a prompt-variable dimension is selected, and only for the usable variable or variables. Use "$ROW will be replaced with the values you specify above" and the corresponding `$COLUMN` wording.

### 3.4. Compatibility presentation

1. Show a compact thinking-effort compatibility table only when at least one selected model/effort combination is known to be unsupported.
2. Its rows and columns match the selected grid dimensions and orientation, including prompt-variable axes and fixed model or effort settings.
3. Use SVG checkmarks for supported combinations and yellow warning icons for unsupported combinations. Unknown support must not be presented as confirmed support.
4. Do not show a tooltip on a supported checkmark. Explanatory hints may identify unsupported or unknown combinations.
5. Compatibility warnings are advisory and must not block generation. Send the selected settings and show an upstream rejection as a cell error if the provider rejects them.

### 3.5. Budget and requested parallelism

1. Text generation requires a per-cell monetary budget, defaulting to $5 per attempt. It covers estimated total cost, including input, output, and thinking.
2. Label the compact field "Budget limit per cell," prepend a dollar icon, and give it proper surrounding spacing. It must not stretch across the form's full width.
3. Respect provider/model limits when translating the budget, without adding an unrelated fixed output-size ceiling. A retry gets a new attempt allowance.
4. Show "# of parallel workers" to the right of the budget before generation starts. Compute its initial value automatically from available balance divided by $3, rounded down with a minimum of one and capped by the grid's cell count.
5. Allow manual override. Put MAX inside the field; it requests rows x columns workers. Preserve the request with the grid so Resume and restored setup use it.
6. Use this worker tooltip: "How many parallel inferences to run (can be throttled by the backend under load). If your inference budget is low, spawning too many will lead to a lot of overhead due to failures; OpenRouter still charges you for unsuccessful calls".
7. The request is a concurrency ceiling, subject to backend capacity and fair allocation, rather than a reservation of workers.

### 3.6. Inference-provider setup

1. Label the section "Inference provider setup". Use a compact OpenRouter status row with the provider identified once.
2. Show Connect when disconnected. In creation, a connected row links to Settings; in Settings, offer Disconnect and a less prominent Change connection action.
3. Show the connection-checking state while it is pending. On a failed check, offer retry without falsely asserting that the user is disconnected or their credentials are invalid.
4. Offer both manual API-key entry and OpenRouter OAuth.
5. Use this Settings note: "More providers coming in the future. For now, use bring-your-own-key feature on OpenRouter to get inference without paying OpenRouter's markup".

## 4. Grid layout and metadata

### 4.1. Table geometry and gestures

1. The grid fills the page below the navbar, with the same overall layout during generation and after publication. Both row and column headers remain sticky, and the top-left corner cell is empty.
2. Rotate row labels 90 degrees counterclockwise and keep header/cell text readable. The row-label column should fit its contents.
3. Keep the first row compact in height and the label column compact in width through restrained header padding. Size output cells independently.
4. Page-height filling may expand output rows, but must never stretch the header row. Its height stays natural through viewport fitting, zoom, resizing, and restoration from localStorage.
5. Users resize output columns and rows through their corresponding header edges. Each shared edge controls the column to its right or row below it, including the last output row. The header row and label column themselves are not resizable.
6. Persist only output dimensions per grid in browser localStorage, without server-wide size persistence. Restoring output sizes must preserve the header's natural height.
7. Support pinch zoom whenever a touchscreen is present, regardless of screen width. Start by fitting the table to available width and prevent zooming out beyond that width fit.
8. Keep one-finger scrolling usable, including within Markdown cells. Zoom the grid rather than the application navbar.
9. Click-dragging empty grid areas scrolls both axes. Drags starting on images, website frames, Markdown or thinking previews, interactive controls, and resize handles retain their own behavior. Image padding belongs to the draggable grid, while images retain their centered, aspect-ratio-preserving fit.

### 4.2. Title, prompt, author, and price

1. Title and prompt are separate values. A new title is empty; use the prompt as the grid's display name when no title is set.
2. In the navbar, show "Set Title" when the title is empty or the title when set, followed by a centered dot and the prompt. Owners can set or change the title independently of the prompt, including after publication.
3. Limit titles to 40 characters. Neither the title nor "Set Title" may be ellipsized.
4. Title text is dark in light mode and white in dark mode. Prompt text uses the same accent color as "grid" in the wordmark.
5. Collapse long prompts, with a hover element over the collapsed prompt showing the complete text.
6. Place an icon-only copy button directly after the inline prompt text; copying applies to the prompt only.
7. Show the author near the title, followed by "cost $0.NN" and, for the grid owner only, "spent $0.MM", separated by centered dots.
8. Truncate both grid totals to two decimal places in the UI. Show an animated ellipsis while inference runs, without wasting navbar space.

### 4.3. Progress and actions

1. Place the progress bar as a thin line under the navbar. Completed and failed cells both count as finished; failed segments are red and successful segments retain the accent color.
2. Show a pulsing spark moving left to right during generation.
3. Put the pause/resume action to the left of the title/prompt. Edit and Publish are compact icon-only controls to its right, using the same visual treatment.
4. Before publication, Edit immediately cancels active inference and returns to parameter selection with the existing setup restored. Generating the edited setup creates a new generation rather than altering published outputs.
5. After publication, offer Fork to restore the setup for modification and generation using the forking user's own connection. Its icon depicts a branch splitting from a continuing main branch.
6. Show model names in row or column labels. Clicking a model name copies its ID without a hover hint, while preserving copy-result feedback; a chain icon to the right of its copy icon opens the model's OpenRouter page in a new tab.

## 5. Outputs and streaming

### 5.1. Shared controls and output preservation

1. Place icon-only Open output, Copy output, and Download output controls at the bottom left of cells as applicable. Open output opens a separate tab.
2. Copy copies the output content and is not shown for websites. Download saves a website as a ZIP containing its files and relative paths.
3. Download filenames follow `<prompt>.slopgrid.com.<grid-id>.<row_parameter>.<column_parameter>.<extension>`. Normalize filename components, replacing spaces and characters unsuitable for filenames with underscores. The domain in this pattern is product-facing filename text.
4. Store generated SVG and Markdown source verbatim, preserving whitespace and code fences.
5. Preserve generated output independently of metadata edits and publication, without an application output-byte limit.
6. Store provider finish reasons without displaying them in the interface. Treat an unsuccessful completion reason as a generation failure rather than silently accepting incomplete output.

### 5.2. Markdown

1. Render Markdown formatting while displaying embedded raw HTML as text.
2. Render Markdown incrementally into the same rendered layout used for completion, retaining the preview and scroll position throughout.
3. Let code blocks take their full natural content width, then scale the whole Markdown document to fit the cell width. Scrolling is vertical only.
4. Add an icon-only raw-view toggle to the left of Expand. Raw mode shows the original Markdown as unformatted text, preserves line breaks, disables wrapping, and scales to the cell width.
5. In raw mode, the button becomes a Markdown icon that returns to rendered Markdown. Keep raw view available during streaming.
6. Put Expand in the top-right corner. Expansion occupies the grid workspace while keeping the navbar visible; collapsing restores the grid's layout and viewing state.

### 5.3. Images and SVG

1. Display generated images and SVG as images that always fit the cell.
2. During SVG streaming, make a disposable partial-image preview by closing unfinished tags where possible. This preview recovery must not modify stored final source. Continue updating the preview while thinking is shown, and reveal the latest preview when switching back to output.
3. Do not reject SVG merely because markup validation considers it malformed or unconventional; browsers may still recover it.

### 5.4. Static websites

1. Generate a static bundle containing `index.html` and optional supporting HTML, CSS, and JavaScript files.
2. Stream website previews as file contents arrive, including partial files. Show entry-page content before all supporting assets have arrived.
3. Load generated CSS, module scripts, and relative assets correctly inside private frames while preserving authorization and sandbox isolation.
4. Keep the current website preview visible until the next preview is ready. Streaming updates and the transition to completed output must avoid a blank-frame blink.
5. Preserve document and scrollable-panel positions across preview updates. Display the latest content without reverting to an older preview.
6. Pause, failure, and a new attempt must not retain a stale temporary website preview.

### 5.5. Thinking traces

1. Capture provider-exposed thinking whenever available, stream it separately from output, and store it for later viewing.
2. Add an icon-only brain button to the left of Expand. It toggles between cell content and the corresponding thinking trace displayed as raw text. Thinking uses a fixed readable font size with word wrapping and vertical scrolling, without scaling text to fit its content width, during streaming and after completion, including expanded views.
3. While output is empty, show arriving thinking automatically; also stream it whenever the cell is explicitly in thinking mode.
   Automatically follow new thinking at the bottom until the user scrolls up. Preserve that reading position as more text arrives, and resume following when the user scrolls back to the bottom.
4. Keep trace state associated with the correct cell and attempt. Late events or fetch responses must not replace the thinking for a newer attempt.
5. Preserve captured thinking across completion, failure, pause, and restart, with the same access policy as the corresponding grid. Do not mix trace files into generated website bundles or downloads.

## 6. Inference, scheduling, and recovery

### 6.1. Worker allocation

1. Use a shared configurable worker pool with a default limit of 100 concurrent cell generations.
2. Aim to give each eligible user at least one worker when possible, then distribute capacity as evenly as possible. Give a newly freed worker to an eligible user with the fewest active workers.
3. Count a user's allocation across their grids. Respect requested grid/session concurrency ceilings as well as the global cap.
4. Do not cancel active work or reserve idle slots merely to rebalance. When limits change, allow existing work to finish while applying limits to new dispatches.

### 6.2. Balance, errors, and retries

1. Check available OpenRouter balance before starting or resuming. Below $3, show a top-up popup with an explicit Continue anyway option; that option uses the selected parallelism.
2. Billing interruptions must let users fix the problem and retry repeatedly without breaking the flow. Preserve completed cells and regenerate only unfinished work.
3. Apply backoff to temporary provider rate and in-flight spending limits, honoring provider retry guidance and releasing worker capacity while waiting so other users can continue.
4. Distinguish transient throttling from genuine billing or authentication failures, which require user action.
5. Propagate provider error messages and codes to the client and retain them with failed cells, including after reload and publication.
6. Ongoing generation continues regardless of elapsed time until it finishes, fails, or the user cancels it.

### 6.3. Pause, resume, and updates

1. Pause immediately aborts active requests for that grid, removes queued work, and discards unfinished output previews. Completed outputs remain intact.
2. Resume restarts unfinished cells, including retries, while preserving completed outputs. It must remain possible after dismissing an interruption popup.
3. Use a red stop-square icon for the stop/pause action and the hint "Work can be resumed later, unfinished responses will be lost".
4. Keep live updates connected while a grid can still change from queued or active generation, including unsettled requests after a pause. Disconnect once stable and reconnect when an action starts work again.
5. Delayed updates must not move title, output, thinking, status, or price backward. Retries must show content from the current attempt.
6. Interrupted unfinished work requires an explicit Resume, preserving completed outputs.

## 7. Costs and billing

### 7.1. Per-cell and grid prices

1. Show cost information per generation. Display input tokens with an upward arrow and output tokens with a downward arrow, using `$` without a redundant USD suffix.
2. Estimate each text cell's price while its response streams, accounting for input, visible output, and available thinking. Replace the estimate with the reported price when the call completes.
3. The cost total is the sum of successful outputs currently shown on the grid plus running inference estimates.
4. The spent total is the sum of all reported billing charges for this grid plus running inference estimates, including failed, cancelled, and retried calls. Replace each running estimate with its reported charge without counting the attempt twice; discard its estimate when work stops. Show spent only to the grid owner and omit it from responses to other viewers.
5. Keep both totals' two-decimal UI truncation separate from stored billing precision.
6. The cost tooltip is "Inference costs for this grid, not including failed attempts". The spent tooltip is "Inference costs for this grid, including failed attempts - how much you have actually spent on this page".

### 7.2. Billing history

1. Provide a separate billing page that records every actual inference call, including retries, failures, and cancellations. Do not include unbilled catalog, balance, or OAuth calls as inference charges.
2. Attribute each call to its grid and provide a link to that grid.
3. Retain reported charges for unsuccessful calls. Do not turn missing provider cost information into an invented zero charge.
4. Billing follows ownership: anonymous users see their session's history, and signed-in users see their account-owned grids' history, including grids claimed on sign-in.
5. Keep finish reasons in durable call records but out of the current UI. Avoid duplicating completion records or usage across multiple persistent representations.

## 8. Identity, publication, and access

### 8.1. Anonymous and GitHub accounts

1. Users are anonymous by default. Offer recognizable GitHub sign-in in the interface.
2. A GitHub identity displays as the GitHub icon followed by a username linked to the profile. Otherwise display "by Anonymous". Show authors near grid titles and in grid listings.
3. Account ownership persists when a GitHub username changes. Refresh display identity on sign-in.
4. On sign-in, atomically claim the current anonymous session's grids for the account, including their billing history. Never claim another account's grids.
5. Account grids and billing are accessible across browsers signed into that account. Signing out removes account access; newly created anonymous grids belong to the current anonymous session.
6. Preserve the initiating inference connection during identity changes so signing in or out does not silently replace credentials or interrupt accepted work.
7. Freeze author attribution at first publication. Later claims, sign-ins, or profile changes must not rewrite a published grid's author; unpublished grids may show the current identity.

### 8.2. Inference credentials

1. Keep OpenRouter connections browser/session-scoped; do not attach them to the GitHub account or copy them to other browsers.
2. Store manually entered keys in the user's localStorage and resend them for authenticated key checks and inference start/resume requests. Hold them only ephemerally on the server while needed for execution, without persistent server storage.
3. Support OpenRouter OAuth connections alongside browser-stored manual keys, with each flow's credential lifecycle handled independently.
4. Public responses must not expose credentials, session ownership tokens, or private runtime data.

### 8.3. Publication and discovery

1. New grids are private. Publish opens "Control who can see this grid" with radio choices "Keep private," "Accessible by link," and "Listed publicly," plus Save and Cancel.
2. Saving Keep private closes without publication. First publication requires confirmation, with Confirm, Cancel, and a "Don't ask again" preference remembered in this browser only after successful confirmation. Failure to access localStorage must not block publication.
3. Use this confirmation text: "This projects aims to facilitate model benchmarking and research, and we don't want valuable data to disappear. For this reason, making a published grid private is impossible."
4. Publication is allowed when every cell is complete or failed. Errors do not prevent publication; pending or running cells do.
5. Publishing permanently locks generation inputs and outputs and prevents returning to private visibility. Title editing remains allowed independently.
6. Provide an owner-visible route and control to promote an already link-accessible grid to public listing. A publicly listed grid cannot be demoted to link-only or private visibility.
7. Link-accessible grids are readable by anyone with the link but excluded from public discovery. Public grids appear newest first beneath Your grids, including the owner's own public grids.
8. Give public discovery its own loading, empty, and failure states, and refresh relevant lists after publication. Show format icons and authors without exposing ownership/session identifiers or nesting profile links inside grid links.
9. Retain copy-link and fork controls for published grids. Dialogs must support keyboard operation, focus restoration, disabled controls while saving, and visible request errors.

### 8.4. Output isolation and private access

1. Private output must be accessible only through an authorized live user session. Knowing a grid, output, preview, download, or thinking URL does not grant access.
2. Apply ownership and session checks consistently to every output format, website asset, preview, download, and thinking trace. Expiry, logout, and account changes must revoke access appropriately.
3. Serve arbitrary HTML bundles from separate per-output hosts. Images, SVG, and Markdown use the application host.
4. Generated HTML must not receive application session cookies, access other outputs' cookies, or reach application API handlers through its output host. Retain isolation while allowing its static scripts and assets to render.
5. Generated websites can access only their own bundle's files.

## 9. Availability and updates

1. Web and interface updates must preserve accepted inference, including queued work, output, thinking, and charges. Browsers reconnect automatically after a brief connection interruption.
2. An inference-machinery update stops accepting new work and lets accepted grids and unsettled calls finish without a cancellation timeout. Cancelling maintenance restores admission.
3. Open browser tabs retain access to their frontend assets across updates. Routine deployments preserve grids, outputs, credentials, and sessions.
