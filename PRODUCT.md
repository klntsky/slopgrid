# Slopgrid requirements

This document defines Slopgrid's product behavior and user experience.

See [README.md](README.md) for an introduction, [ARCHITECTURE.md](ARCHITECTURE.md) for architecture constraints and implementation, and [DEVELOPMENT.md](DEVELOPMENT.md) for development and validation guidance.

## 1. Product

### Product goal

> we want to make anything possible in openrouter possible in the app, with warnings and disclaimers

Status: high level product goal that is not a requirement (not achieved yet).

### 1.1. Benchmarking model outputs

1. Slopgrid lets people submit a prompt and compare generated outputs in a two-dimensional grid whose row and column meanings they choose.
2. Support model and prompt-variable axes for every output type, thinking-effort axes for text outputs, and size, aspect ratio, quality, background, and input-reference axes for images.
3. Offer four output types in this order: Markdown, Image, SVG, and Static website. Image generation uses image-capable models; static websites may contain multiple files, which are served without server-side execution.
4. Generate outputs on the server, stream progress to the browser, retain completed results, and let owners publish their grids afterward.
5. A cell attempt makes one inference call.
6. Apply sensible request and generation rate limits without imposing deadlines on accepted inference.
7. When a user action receives HTTP 429, show the rate-limit message, preserve their inputs and completed results, and leave the action available for an explicit retry. Validation, admission, and rate-limit rejection before a grid is saved must leave the user on the form without creating a grid.
8. Retrying the same grid-creation submission after a lost response or reload must recover the existing grid rather than create a duplicate. Once a grid is saved, open that grid even if generation cannot start or its startup acknowledgement is lost. Recover its current generation state before offering Resume, and do not restart inference merely by replaying creation.

## 2. Interface, navigation, and presentation

### 2.1. Visual language

1. Use a dim, slightly warm light theme and a subtly warm dark theme. Settings offers System, Light, and Dark; System is the default and follows system appearance. On desktop, show a sun icon in dark mode and a moon icon in light mode; activating it immediately switches to and saves the opposite theme.
2. Use the custom 5x5-cell SVG project mark to the left of the website name, and give the word "grid" the same accent color as the logo squares. On grid pages, show only the logo on mobile and touch devices regardless of viewport width or orientation, and at widths of 700px or less, while keeping the link's accessible site name. All other pages show both the logo and website name at every width.
3. Use permissively licensed stock interface icons alongside official OpenRouter and GitHub brand assets. Brand icons must remain recognizable and uncropped.
4. Keep buttons consistent throughout the interface, with restrained borders, padding, and corner rounding. Secondary buttons, including the hamburger and theme controls, have no borders. Output-type cards should have larger icons and labels without excessively rounded corners.
5. Use concise, distinct headings and labels without repeating information already visible in the section.
6. Explicit theme changes use the polygon reveal from https://theme-toggle.rdsx.dev/, reversing direction for light and dark, regardless of motion preferences. Switch immediately when view transitions are unavailable.

### 2.2. Navigation and page layout

1. The logo opens `/grids` and serves as the navbar's grid-list link. Put the prominent NEW GRID action, with a plus icon, on the grid-list page.
2. Keep navbar link labels uppercase, with readable desktop text and enough space for grid information. Use matching gaps between the brand, action buttons, and title/prompt group.
3. For navigation, use the primary input capability independently of viewport width or orientation. Touch-primary devices use a hamburger menu anchored close to its button and keep theme selection in Settings. Mouse-primary devices show navigation links directly alongside the theme toggle, including when secondary touch support is reported. Keep compact grid action buttons on the first navbar row where they fit. At widths of 480px or more, place the grid title, prompt, and byline in the center of that row between the logo and actions; below 480px, give that information a full-width second row.
4. Give "Your grids" and "Public grids" matching large heading styles. Keep separators only between grid entries in the lists.
5. Billing and Settings use the same wider page-layout approach as `/grids`.
6. Convey publication state through the available grid actions, placement in the public list, and a lowercase "published" label in the owner's grid list. Unpublished entries show their lowercase generation status.
7. A missing grid should show its 404 promptly without retrying. Keep the error message focused on the missing grid.
8. Connection loss appears as a small bottom-right label with a rotating preloader and must not shift page layout. Generation preloaders must visibly spin.
9. Beneath Public grids, show "See what others have created". Introduce the billing history with "Each inference attempt appears here, including retries, failures, and cancellations. OpenRouter bills your account directly."

### 2.3. Tooltips

1. Tooltips have consistent behavior and a pitch-black background with white text in both themes. Showing or hiding a tooltip must not shift the surrounding layout, including the cost and spent values.
2. Use hints only to explain a non-obvious action, icon, or value, consistently across the frontend.
3. Explain the budget as "Used to calculate each output's token limit." Use the cost and spent hints specified in section 7.1.
4. Give token-arrow indicators "Input tokens" and "Output tokens" hints. Supported compatibility checkmarks do not get tooltips.
5. Budget hints use field-level interaction.
6. Use the current pause hint specified in section 6.3.
7. When Generate is disabled, its tooltip explains the current blocking reasons. Attach the tooltip to a focusable wrapper so it works on hover and keyboard focus while the button is disabled, and omit it when Generate is enabled.

## 3. Grid creation

### 3.1. Form and output selection

1. The creation-page call to action is "Create your own AI model benchmark". The layout heading is "Specify grid layout", followed by a centered dot and "what should be the rows and the columns of the grid?". Put fixed model, thinking effort, and image settings outside the row and column axes in a separate "Specify common parameters" section between the layout and prompt sections. Omit this section when it has no parameters, keeping subsequent section numbers consecutive. Arrange common Size, Aspect ratio, and Background inputs in a single flex row that wraps on smaller screens, with Quality and Input references below when present.
2. Before an output type is selected, show public grids below the output-type selection. Selecting an output type hides this list and reveals all remaining form sections immediately, while keeping the output choice visible. A restored draft with an output type already selected also hides the list. Preserve the creation page's scroll position on refresh and browser history navigation, while new route visits start at the top.
3. Preserve the in-progress setup through provider authorization and restore the applicable setup when editing or forking.
4. Put an icon-only swap button between the row and column selectors. It has no border and swaps axis types, selected values, and corresponding prompt-variable references together.
5. New image grids start with Model rows and Quality columns, with Auto as the only selected quality and no models selected. SVG and Website grids start with unselected model rows and thinking-effort columns with Model default checked. Markdown grids start with thinking-effort rows with Model default checked and unselected model columns. Restored drafts, Edit, and Fork preserve their saved layout and selections. Every generation must use an explicitly selected model, including when model is a fixed setting rather than an axis.
6. Grid creation has no application limit on prompt length, axis-value length, model-ID length, JSON request size, number of axis values, cells, or requested parallel workers. Forward these inputs subject to OpenRouter's limits. Actual concurrency follows the shared worker allocation policy.
7. Arrange short axis choices, including aspect ratios, size presets, quality, background, and thinking efforts, as inline checkboxes that wrap onto additional rows as needed. Keep each checkbox and its label together.

### 3.2. Model and thinking-effort selection

1. Model lists are filterable and alphabetically ordered, with a tall selection area that makes multiple options visible at once.
2. The filter has a magnifying-glass icon, the placeholder "Search models," and an always-visible clear cross.
3. Initialize model-axis searches to an empty string for Image and to `latest` for every other output type. Initialize the fixed-model search to `latest` for every output type. This filter must not select a model automatically.
4. Show selected models as removable badges under multi-model lists, including selections currently hidden by the filter. Model-axis badges support mouse and touch dragging and focused arrow-key movement to reorder selections. While dragging, highlight the insertion space between badges, including the positions before the first and after the last badge, and insert the dragged badge there on release. The insertion marker follows the pointer across wrapped badge rows. Insert each newly selected model beside the selected model closest to it in the complete, unfiltered list, before or after that neighbour according to catalog order. Resolve equal distances toward the earlier catalog entry and preserve the relative order of existing selections, including manual reordering. Neither the badge's model name nor its remove button has a tooltip. Removing a model does not focus the model filter; clearing the filter does.
5. Shift-click selects or clears a range of visible model checkboxes according to the clicked checkbox's new state.
6. Use the term "thinking effort." Order efforts by their semantic levels rather than alphabetically or by selection order, and let the effort selector expand to its full content height without an inner scrollbar.
7. A model or effort that is not an axis applies as a fixed selection to the grid. Use the same searchable model selector for the fixed model, with radio buttons allowing one selection. Keep "Model default" thinking distinct from automatic model selection: the former leaves the model's thinking configuration unspecified.
8. Make the complete model catalog, image pricing, and image capabilities available on the first client render through a JSON data script baked into the page HTML. The browser uses that snapshot without model refetches or server-side component rendering. The server loads the data together, refreshes its in-memory snapshot periodically, and serves model-list reads without rate limits.

9. Show right-aligned input and output prices per million tokens beside text models in both axis and fixed-model selectors. Tooltips show the full input and output rates and any published per-request charge. Use the embedded catalog without additional requests, preserve published zero prices, and show "Price unavailable" when pricing is missing.

10. Resolve published model alias targets before saving a grid. For catalog aliases without a published target, retain and submit the selected alias. When such a selected alias has a canonical slug, show: "The model alias <alias> is a reference to <canonical slug here>, which is not an established model snapshot. In the future, the alias may move its target without the ability to refer to the old snapshot". Substitute the catalog values in both fixed-model and model-axis selectors. Prefix the warning with a warning emoji and use the normal text color.

### 3.3. Prompt variables

1. Use `$ROW` and `$COLUMN` for literal substitution of the corresponding prompt-variable values.
2. Support either or both axes as prompt variables, using the values supplied for each axis to expand the grid.
3. Each enabled prompt variable must occur in the prompt before generation can start. A prompt containing `$ROW` or `$COLUMN` also requires the corresponding axis to be a prompt variable; these tokens are reserved for substitution.
4. Show variable guidance only when a prompt-variable dimension is selected, and only for the usable variable or variables. Use "$ROW will be replaced with the values you specify above" and the corresponding `$COLUMN` wording.
5. Beneath each prompt-variable values field, show "One value per line. Use $ROW to reference this value in the prompt." for rows and the corresponding `$COLUMN` wording for columns.
6. New prompt-variable axes start empty. Show `cat` and `dog` on separate lines as a placeholder, without adding them to the selected values.

### 3.4. Compatibility presentation

1. Show a compact thinking-effort compatibility table only when at least one selected combination is known to be unsupported. For images, show a separate compatibility grid for each parameter type with a known incompatibility, such as Size, Aspect ratio, Quality, Background, or Input references. Hide grids containing only supported or unknown results. Place each compatibility grid directly below its corresponding parameter input, whether that input is a row axis, column axis, or common parameter. Keep the grid with its input when the layout changes.
2. The thinking-effort table always has selected models as rows and selected thinking efforts as columns, including fixed model or effort settings, without repeating combinations for prompt variables. Each image compatibility grid has models as rows and that parameter's selected values as columns, including shared settings and reference groups. Swapping generation axes preserves this compatibility layout. Check complete image settings against individual provider endpoints, including reference counts, and attribute combination conflicts only to the involved parameter types.
3. Use SVG checkmarks for supported combinations, yellow warning icons for unsupported combinations, and a question mark emoji for unknown support.
4. Do not show a tooltip on a supported checkmark. Image warning tooltips identify the incompatible parameter values or conflicting settings; unknown results identify which support information is unavailable.
5. Compatibility warnings are advisory and must not block generation. Send the selected settings and show an upstream rejection as a cell error if the provider rejects them.

### 3.5. Budget and automatic parallelism

1. Text generation requires a per-cell monetary budget, defaulting to $3 per attempt. Preserve saved budgets. It covers estimated total cost, including input, output, and thinking. Image generation does not require a text budget; a missing or invalid text budget must not block image generation after a format change or draft restoration.
2. Label the compact field "Budget limit per cell," prepend a dollar icon, and reserve enough input padding to keep the value clear of the icon. It must not stretch across the form's full width.
3. Respect provider/model limits when translating the budget, without adding an unrelated fixed output-size ceiling. A retry gets a new attempt allowance.
4. The creation form uses automatic parallelism. For text, estimate each cell from its expanded prompt, applicable token prices, request fees, and budget-capped output allowance within model and context limits. Use $3 per cell when a complete estimate is unavailable. Sum cells in dispatch order until the next would exceed available balance, with at least one worker and at most the cell count. Unknown balance recommends one worker. Image recommendations use available balance divided by $0.40, rounded down with the same bounds.
5. The request is a concurrency ceiling, subject to backend capacity and fair allocation, rather than a reservation of workers.
6. Recalculate automatic text concurrency from unfinished cells after artifact reuse and on Resume; retain existing grids' saved explicit counts on Resume. New form submissions use automatic selection, including Edit and Fork. Initial recommendations do not guarantee sufficient balance for later calls.
7. Show advisory text warnings near the budget, listing affected models and their highest estimated maximum call costs across expanded prompts. Prefix each model warning with the same warning icon used in compatibility tables. Group repeated models across thinking efforts and other axes into one warning per model. Show unknown estimates explicitly, including when the same model also has calculated warnings. The $3 fallback is not a calculated model maximum.
8. Use this tooltip for a calculated reduction, filling only the placeholders: "The max cost you specified ($<insert here>) is lower than the cost of this model's available max_output_tokens at the current price ($<calculate here>). This causes slopgrid to set max_output_tokens for an inference call to a lower value than what the model supports, effectively increasing the chance of a failure due to insufficient tokens to produce a response. Consider increasing your inference cost limit: model providers charge for failed requests anyway."

### 3.6. Inference-provider setup

1. Provider connection controls belong in the creation form and Settings. Label the section "Inference provider setup" and use a compact OpenRouter status row with the provider identified once.
2. Show Connect when disconnected. In creation, a connected row links to Settings; in Settings, offer Disconnect and a less prominent Change connection action.
3. The connection row shows the connection-checking state while a check is pending and offers retry when a check fails. Generate's blocking tooltip says "Connect OpenRouter." whenever no connection is confirmed, including while the initial check is pending or after it fails.
4. Offer both manual API-key entry and OpenRouter OAuth.
5. Use this Settings note: "More providers coming in the future. For now, use bring-your-own-key feature on OpenRouter to get inference without paying OpenRouter's markup".

### 3.7. Image-generation dimensions

1. Either image axis can compare Size, Aspect ratio, Quality, Background, or Input references, alongside models and prompt variables. Keep the selected model explicit when neither axis contains models.
2. Size offers resolution presets and a Custom option that reveals separate Width and Height fields for pixel dimensions. A shared Size field has one pair; size axes support multiple pairs with controls to add or remove each pair alongside the selected presets. Both dimensions must be positive whole numbers before generation. Aspect ratio, quality, and background provide selectable values; capability warnings do not remove those choices.
3. Each Input references axis value is a group of user-selected image files sent together to each corresponding cell. Allow adding groups, editing their titles, adding files to a group, and removing individual files or groups, with image previews. Title editing uses the same interaction as grid titles: click to edit, Enter or blur to save, and Escape to cancel. Titles must be nonempty and distinct within the axis; renaming preserves the group's files, and titles persist through reloads, generation, editing, and forking.
4. Keep newly selected files in the browser until Generate is clicked. Retain the local selection across reloads and provider authorization, and start uploading only on submission. Upload files separately and reuse stored references when editing or forking saved grids.
5. Preserve image settings and selected reference groups with the grid. Settings affect inference parameters without being inserted into the prompt. A private reference is accessible to its owner or through an owned grid that uses it; publishing a grid shares only its selected references with viewers and forks.
6. Save reference images with the grid and format the corresponding row or column headers as "references: <title>" followed by tiny inline image previews in group order. Clicking a preview opens that reference in the full-page image view, with the same collapse and Escape behavior as generated images.
7. In the layout and common-parameter sections, show each reference group's heading as a pencil icon, editable group title, centered dot, and "reference image group". Its file-selection button shows a paperclip icon and "Add images".
8. Right-align OpenRouter's published output rates in the image-model checkbox list, preserving per-image and per-megapixel units and displaying token rates per million tokens. Show a range when published rates differ within the same unit, and keep different units separate. A tooltip lists provider names, additional charges, and pricing tiers. Missing prices display "Price unavailable". Rates are independent of the selected generation settings.
9. Reference uploads accept PNG, JPEG, and WebP images, with a maximum of 20 MiB per file. Reject other formats and oversized uploads with a visible error.
10. Removing a group's last image preserves the empty group and its title, including after reload. Generate validates that every selected group contains at least one image and shows an error for an empty group. Users may refill or explicitly remove the group.
11. For Image output, show separate configurable Size, Aspect ratio, Quality, Background, and Input references fields whenever they are absent from both axes. Scalar fields start at Auto, which is equivalent to unspecified and omits the parameter from inference requests; Auto axis values behave the same way. Shared references start empty and apply to every cell. Preserve shared settings and references through draft reload, authorization, Generate, Edit, and Fork.
12. Moving a configured image field into a row or column dimension transfers its value into the axis selection; shared references become one selected reference group. When a parameter leaves an axis, its separate field resets to Auto or an empty reference collection. Swapping axes preserves selections.

## 4. Grid layout and metadata

### 4.1. Table geometry and gestures

1. The grid fills the page below the navbar, with the same overall layout during generation and after publication. Both row and column headers remain sticky, and the top-left corner cell is empty.
2. Rotate row labels 90 degrees counterclockwise and keep header/cell text readable. The row-label column should fit its contents.
3. Keep the first row compact in height and the label column compact in width through restrained header padding. Size output cells independently.
4. Page-height filling may expand output rows, but must never stretch the header row. Its height stays natural through viewport fitting, zoom, resizing, and restoration from localStorage.
5. Users resize output columns and rows through their corresponding header edges. Each shared edge controls the column to its right or row below it, including the last output row. The header row and label column themselves are not resizable. Resizing permits column widths from 120 to 20,000 pixels and row heights from 160 to 20,000 pixels.
6. Persist only output dimensions per grid in browser localStorage, without server-wide size persistence. Restoring output sizes must preserve the header's natural height.
7. Support pinch zoom whenever a touchscreen is present, regardless of screen width. Start by fitting the table to available width and prevent zooming out beyond that width fit. Limit zooming in to three times the table's unscaled size.
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
8. Truncate both grid totals to two decimal places in the UI. While inference runs, animate a gradient wave across the cost and spent text themselves.

### 4.3. Progress and actions

1. Place the progress bar as a thin line under the navbar. Completed and failed cells both count as finished; failed segments are red and successful segments retain the accent color.
2. Show a pulsing spark moving left to right during generation.
3. Put the pause/resume action to the left of the title/prompt. Edit and Publish are compact icon-only controls to its right, using the same visual treatment.
4. Before publication, Edit immediately cancels active inference and returns to parameter selection with the existing setup restored. Generating the edited setup creates a new grid and can reuse matching completed artifacts as specified in section 10.
5. After publication, offer Fork to restore the setup for modification and generation using the forking user's own connection. Its icon depicts a branch splitting from a continuing main branch.
6. Show model names in row or column labels. Clicking a model name copies its ID without a hover hint, while preserving copy-result feedback; a chain icon to the right of its copy icon opens the model's OpenRouter page in a new tab. Copy and link icons follow the same orientation as the label text, including in rotated row titles.

## 5. Outputs and streaming

### 5.1. Shared controls and output preservation

1. Place icon-only Open output, Copy output, and Download output controls at the bottom left of cells as applicable. Open output opens a separate tab.
2. Copy copies the output content and is not shown for websites. Download saves a website as a ZIP containing its files and relative paths.
3. Download filenames follow `<prompt>.slopgrid.com.<grid-id>.<row_parameter>.<column_parameter>.<extension>`. Normalize filename components, replacing spaces and characters unsuitable for filenames with underscores. The domain in this pattern is product-facing filename text.
4. Store generated SVG and Markdown source verbatim, preserving whitespace and code fences.
5. Preserve generated output independently of metadata edits and publication, without an application output-byte limit.
6. Store provider finish reasons without displaying them in the interface. Treat an unsuccessful completion reason as a generation failure rather than silently accepting incomplete output. When reported thinking tokens exhaust the requested output-token limit without producing output, show "The model spent all of its <limit> output token limit on thinking without producing output - this is a common failure mode of some models indicating that the thinking level is too high for the task", substituting the actual limit (for example, 234K). Preserve its thinking trace and charges.

### 5.2. Markdown

1. Render Markdown formatting while displaying embedded raw HTML as text.
2. Render Markdown incrementally into the same rendered layout used for completion, retaining the preview and scroll position throughout.
3. Let code blocks take their full natural content width, then scale the whole Markdown document to fit the cell width. Scrolling is vertical only. Use a bundled monospace font with equal advance widths for spaces and full-block characters, and `line-height: normal` for rendered code blocks in grid previews and direct output pages. Use the same bundled font for Markdown source views.
4. Add an icon-only raw-view toggle to the left of Expand. Raw mode shows the original Markdown as unformatted text in a monospace font, preserves line breaks, disables wrapping, and scales to the cell width.
5. In raw mode, the button becomes a Markdown icon that returns to rendered Markdown. Keep raw view available during streaming.
6. Put Expand in the top-right corner. Expansion occupies the grid workspace while keeping the navbar visible; collapsing restores the grid's layout and viewing state.

### 5.3. Images and SVG

1. Display generated images and SVG as images that always fit the cell. Provide an icon-only Expand button that opens the output in the grid workspace while keeping the navbar visible. Collapse or Escape restores the grid layout, viewing state, and button focus. SVG previews continue streaming while expanded.
2. During SVG streaming, make a disposable partial-image preview by closing unfinished tags where possible. This preview recovery must not modify stored final source. Continue updating the preview while thinking is shown, and reveal the latest preview when switching back to output.
3. Do not reject SVG merely because markup validation considers it malformed or unconventional; browsers may still recover it.
4. Cache completed SVG and image files as immutable. Published files may use a one-year cache. Private files use a one-year browser-only cache, separated by session cookie, so revisiting or expanding them does not refetch their content.

### 5.4. Static websites

1. Generate a static bundle containing `index.html` and optional supporting files of any extension, including files without an extension. Accept generated assets regardless of file type or contents and serve them statically without server-side execution. Bundle paths remain confined to that output's files.
2. Stream website previews as file contents arrive, including partial files. Show entry-page content before all supporting assets have arrived.
3. Load generated CSS, module scripts, and relative assets correctly inside private frames and when opening or reloading a direct output URL. Direct tabs render the website at its isolated output URL without a frame wrapper, while preserving authorization and sandbox isolation.
4. Keep the current website preview visible until the next preview is ready. Streaming updates and the transition to completed output must avoid a blank-frame blink.
5. Preserve document and scrollable-panel positions across preview updates. Display the latest content without reverting to an older preview.
6. Pause, failure, and a new attempt must not retain a stale temporary website preview.
7. Provide icon-only expansion for streaming and completed websites in the full grid workspace while keeping the navbar visible. Websites remain interactive and keep receiving streamed updates while expanded. Collapse or Escape, including Escape from inside the website, restores the grid layout and button focus.

### 5.5. Thinking traces

1. Capture provider-exposed thinking whenever available, stream it separately from output, and store it for later viewing.
2. Add an icon-only button to the left of Expand that toggles between cell content and the corresponding thinking trace displayed as raw text. Use a brain icon to show thinking and a palette icon to return to output. Thinking uses a fixed readable font size with word wrapping and vertical scrolling, without scaling text to fit its content width, during streaming and after completion, including expanded views.
3. While output is empty, show arriving thinking automatically; also stream it whenever the cell is explicitly in thinking mode.
   Automatically follow new thinking at the bottom until the user scrolls up. Preserve that reading position as more text arrives, and resume following when the user scrolls back to the bottom. Appended content and layout changes must not stop following.
4. Keep trace state associated with the correct cell and attempt. Late events or fetch responses must not replace the thinking for a newer attempt.
5. Preserve captured thinking across completion, failure, pause, normal restarts, and routine deployments, with the same access policy as the corresponding grid. Emergency shutdowns or process crashes may lose thinking that has not yet been persisted; already persisted thinking must remain available. Do not mix trace files into generated website bundles or downloads.

## 6. Inference, scheduling, and recovery

### 6.1. Worker allocation

1. Use a shared configurable worker pool with a default limit of 100 concurrent cell generations.
2. Aim to give each eligible user at least one worker when possible, then distribute capacity as evenly as possible. Give a newly freed worker to an eligible user with the fewest active workers.
3. Count a user's allocation across their grids. Respect requested grid/session concurrency ceilings as well as the global cap.
4. Do not cancel active work or reserve idle slots merely to rebalance. When limits change, allow existing work to finish while applying limits to new dispatches.

### 6.2. Balance, errors, and retries

1. Check available OpenRouter balance before starting or resuming inference. Image generation below $3 shows a top-up popup with an explicit Continue anyway option; that option uses automatic parallelism for new grids. Text generation uses calculated parallelism for new grids and OpenRouter's admission decisions. Existing grids retain their saved explicit counts on Resume. Fully reused grids require no inference balance check.
2. Billing interruptions must let users fix the problem and retry repeatedly without breaking the flow. Preserve completed cells and regenerate only unfinished work.
3. Apply exponential backoff to provider rate limits, honoring provider retry guidance and releasing worker capacity while waiting so other users can continue. Automatically retry in-flight spending-limit billing errors only when OpenRouter supplies a valid Retry-After delay or another documented backoff mechanism; otherwise pause for user intervention rather than automatically retrying the billing failure.
4. Among provider errors, only pricing or billing errors may automatically pause queued batch work. Other provider failures, including age verification, model access restrictions, and invalid or missing credentials, fail only their affected cells while other cells and grids continue. Preserve the provider explanation on each failed cell. Recoverable infrastructure persistence failures suspend new dispatch as specified in section 9.
5. Propagate provider error messages and codes to the client and retain them with failed cells, including after reload and publication.
6. Ongoing generation continues regardless of elapsed time until it finishes, fails, or the user cancels it.
7. Recognize exhausted OpenRouter key, workspace, and guardrail budgets reported as HTTP 403 as billing interruptions, while other permission errors affect only their cells.

### 6.3. Pause, resume, and updates

1. Pause immediately aborts active requests for that grid, removes queued work, and discards unfinished output previews. Completed outputs remain intact. Pause and Edit must not wait for persistence before cancelling inference. If saving cancellation fails, the running engine must retain the cancellation and prevent further dispatch for that grid. After an engine restart, interrupted unfinished work remains available for explicit Resume.
2. Resume restarts unfinished cells, including retries, while preserving completed outputs. It must remain possible after dismissing an interruption popup.
3. Use a red stop-square icon for the stop/pause action and the hint "Work can be resumed later, unfinished responses will be lost".
4. Keep live updates connected while a grid can still change from queued or active generation, including unsettled requests after a pause. After manual Pause, keep receiving updates until every cancelled call has settled and the final status and billing snapshot has reached the page. Reloading or reconnecting during settlement must recover the current state and continue receiving updates. A persistence failure must not unnecessarily stop authorized live progress updates or present uncommitted completion as durable. Keep the grid live until outstanding calls and pending persistence settle; deny access when authorization cannot be checked. Close the SSE connection only after receiving the stable snapshot, and reconnect when an action starts work again.
5. Delayed updates must not move title, output, thinking, status, or price backward. After an engine restart, delayed pre-restart snapshots must not reopen live updates for a settled grid. Snapshot ordering tokens may change when settled state is read again or the engine restarts. Retries must show content from the current attempt.
6. Interrupted unfinished work requires an explicit Resume, preserving completed outputs.

## 7. Costs and billing

### 7.1. Per-cell and grid prices

1. Show cost information per generation. Display input tokens with an upward arrow and output tokens with a downward arrow, using `$` without a redundant USD suffix.
2. Show running input and output token counts alongside each text cell's running price, using the same layout and arrows as final counts. Estimate usage from input, visible output, and available thinking while streaming, mark estimates as approximate, and replace them with provider-reported usage when the call completes. Use a monospace font for the per-cell counts and price to reduce text movement.
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
6. Show an aggregate reported-charge total and call count, including the count of calls with unavailable charges. Provide a manual Refresh billing control and a Call column showing each call's `direct` or `image` phase. Present 50 calls per page with Previous and Next controls, and refresh automatically while calls are running.

## 8. Identity, publication, and access

### 8.1. Anonymous and GitHub accounts

1. Users are anonymous by default. Offer recognizable GitHub sign-in in the interface.
2. A GitHub identity displays as the GitHub icon followed by a username linked to the profile. Otherwise display "by Anonymous". Show authors near grid titles and in public grid listings; omit authors from the owner's own grid list.
3. Account ownership persists when a GitHub username changes. Refresh display identity on sign-in.
4. On sign-in, atomically claim the current anonymous session's grids for the account, including their billing history. Never claim another account's grids.
5. Account grids and billing are accessible across browsers signed into that account. Signing out removes account access; newly created anonymous grids belong to the current anonymous session.
6. Preserve the initiating inference connection during identity changes so signing in or out does not silently replace credentials or interrupt accepted work.
7. Freeze author attribution at first publication. Later claims, sign-ins, or profile changes must not rewrite a published grid's author; unpublished grids may show the current identity.
8. Sessions persist indefinitely until explicitly revoked or rotated. Application and private-output cookies persist across browser restarts and are renewed during use for as long as the browser permits, preserving access without periodic sign-in. Browser cookie deletion still removes that browser's access.

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
5. Publishing permanently locks generation inputs and outputs and prevents returning to private visibility. Public grids cannot be deleted so that benchmark data remains available. Title editing remains allowed independently.
6. Provide an owner-visible route and control to promote an already link-accessible grid to public listing. A publicly listed grid cannot be demoted to link-only or private visibility.
7. Link-accessible grids are readable by anyone with the link but excluded from public discovery. Public grids appear newest first beneath Your grids and below the creation page's output-type selection until a type is selected, including the owner's own public grids.
8. Give public discovery its own loading, empty, and failure states, and refresh relevant lists after publication. Show format icons and authors without exposing ownership/session identifiers or nesting profile links inside grid links.
9. Retain copy-link and fork controls for published grids. Dialogs must support keyboard operation, focus restoration, disabled controls while saving, and visible request errors.

### 8.4. Output isolation and private access

1. Private output belongs to the owning user account and is accessible from any live session signed into that account, including direct output links in another browser. Anonymous grids remain accessible through their anonymous browser identity until claimed on sign-in. Knowing a grid, output, preview, download, or thinking URL does not grant access to another user or an unauthenticated visitor.
2. Apply ownership and session checks to network requests for every output format, website asset, preview, download, and thinking trace. Completed private SVGs and images may reuse a browser cache entry for the same session cookie until the cache entry expires. Cookie changes after logout or account switching must prevent reuse of that private entry; stale entries require authorization again.
3. Serve arbitrary HTML bundles from separate per-output hosts. Images, SVG, and Markdown use the application host.
4. Generated HTML must not receive application session cookies, access other outputs' cookies, or reach application API handlers through its output host. Retain isolation while allowing its static scripts and assets to render.
5. Generated websites can access only their own bundle's files.

## 9. Availability and updates

1. Web and interface updates must preserve accepted inference, including queued work, output, thinking, and charges. Browsers reconnect automatically after a brief connection interruption.
2. An inference-machinery update stops accepting new work and lets accepted grids and unsettled calls finish without a cancellation timeout. Cancelling maintenance restores admission.
3. Open browser tabs retain access to their frontend assets across updates. Routine deployments preserve grids, outputs, credentials, and sessions.
4. Recoverable infrastructure persistence failures suspend admission and new inference dispatch while preserving accepted calls and retaining their results for persistence recovery. Resume dispatch automatically after recovery, subject to manual Pause and maintenance restrictions, without requiring users to Resume grids solely because of the storage interruption. Do not replay provider calls to recover a failed persistence operation.
5. Recovery from disk-full errors is outside the supported failure-recovery scope.

## 10. Reusing completed artifacts

1. Edit and Fork retain the source grid through draft reloads and provider authorization. Above Generate, show "Reuse existing artifacts from the previous version", checked by default, with the tooltip "Copy existing artifacts with matching generation settings that fit the token limit". Hide this checkbox for creation without a source, and regenerate every cell when it is unchecked. Connection and balance requirements apply even when all cells can be copied.
2. Search only the selected accessible source grid, including owned private grids and other users' published grids. Reuse completed outputs with matching generation settings that fit the destination's computed token limit, choosing the first eligible cell in grid order and allowing it to satisfy multiple destination cells. Missing provenance, incomplete bundles, unreadable files, or missing recorded thinking require generation.
3. Matching includes output format, resolved model, substituted prompt, instructions, thinking settings, provider routing, structured-output schema, image settings, ordered reference content, and provider adapter version. Compare reported output tokens, including thinking, with the destination's computed max_tokens; reuse when usage is at or below that limit, regardless of the original budget or token ceiling. If usage is unavailable, reuse only when the recorded original ceiling fits the new limit. Dollar budgets are not matching parameters, and image calls have no text token limit. Positions, titles, reference filenames and identifiers, worker counts, and object-key order do not affect matching; labels that change the substituted prompt do. Omitted and explicit Auto image settings are equivalent, and image calls ignore text thinking settings. Retain exact routing and price-cap checks because they can change provider selection.
4. Copies have fresh cell identifiers, independent files and thinking, and the destination's ownership and publication rules. Copied cells appear complete immediately, while only unmatched cells generate. An entirely copied grid completes without inference calls. Preserve reported usage and original artifact costs in Cost; copies add no billing entries or Spent.

5. Reuse must preserve per-cell generation failures: unavailable model pricing or an insufficient cell budget affects that cell without rejecting creation of the grid.
