# Slopgrid requirements

This document defines Slopgrid's product behavior and user experience.

## Presentation and interaction requirements

The following numbered requirements define the visible layout and interaction contract.

1. Center ordinary pages in a 950px maximum-width column, including 28px horizontal padding and 56px top padding. At phone widths, use 20px horizontal and 36px top padding.
2. Use 48px medium-weight page headings, reducing to 38px on phones, and 19px medium-weight section headings.
3. Use the warm beige and olive light palette and warm charcoal dark palette, including all panel, border, selection, link, and icon colors.
4. Use an 88px ordinary-page navbar with 5vw horizontal margins on desktop and a compact 64px minimum-height grid navbar. Phone navigation wraps with 20px ordinary-page and 10px grid-page horizontal padding.
5. Show the labeled GitHub sign-in button before Billing and Settings on desktop.
6. Underline the active Billing or Settings navigation link.
7. Anchor the touch navigation trigger at the right edge, with a 300px popup constrained to the viewport and separated from its trigger by 4px.
8. Include GitHub account controls, Billing, and Settings in the touch popup, and change the open menu trigger to a close icon.
9. Use the established filled primary buttons and borderless secondary actions, with matching padding, dimensions, hover states, and rounding.
10. Use a 2px themed keyboard focus outline with a 3px offset on interactive controls.
11. Present output formats as five equal vertical cards, with icons above labels, changing to two equal columns on phones.
12. Use file-text, image, code-file, browser-window, and chat-message format icons at 44px with a 1.5px stroke in the format cards.
13. Mark the selected format with a tinted fill and reinforced outline.
14. Separate creation sections with horizontal rules and small muted two-digit numbers, beginning with What do you want to generate? and numbering provider setup consecutively.
15. Keep the layout heading and its explanatory subtitle at the same size and weight, wrapping together.
16. Show the selected row count, column count, and total output count below the axes.
17. Place the model-search magnifier and clear control inside its input boundary, retaining the established results-panel typography, fill, border, and spacing.
18. Show selected models as filled removable chips.
19. Enclose preset checkboxes in a bordered panel and use the theme accent for checked states.
20. Align the axis swap control with desktop selectors and rotate its arrows vertically when axes stack on phones.
21. Stretch common image options across equal desktop columns and stack full-width controls on phones.
22. Show reference uploads in a bordered group with a shared Input references label, thumbnails, visible filenames, compact remove icons, and a paperclip Add images action.
23. Use a six-row prompt textarea with the placeholder Describe what you want to generate and the section heading Enter your prompt, without a redundant visible Prompt label. Chat completion replaces this widget with a two-column editor headed Enter chat history: the first column contains the drag handle and role badge, and the second contains the message input. Keep the role column compact and at a fixed width so changing roles does not shift message inputs, and use a smaller font for the word assistant while preserving the badge height. Align the top edges of role badges, drag handles, and message inputs, including when messages expand, and give drag handles the same height as badges. Multiline message inputs start at one line and automatically grow and shrink to fit their content, including wrapped lines, without internal scrolling or a resize handle. Match role badges to the existing badge styling, use equal left and right padding, and retain their role colors on hover. Give badges equal widths within the role column. Insertion buttons span the full editor width in compact gaps between messages, with plus icons centered horizontally between badges and inputs and vertically between message rows. Immediately focus each newly inserted input. Reveal insertion controls when hovering between messages and the deletion cross when hovering over its message input; keyboard focus also reveals these controls. Keep all insertion plus buttons visible on touch devices and devices without hover.
24. Place the budget below the provider connection and keep its dollar icon inside the input boundary.
25. Show the provider logo, OpenRouter name, and stacked connection status in a bordered identity card, with actions beside them and a visible logo in both themes.
26. Expand API-key entry inline within the provider card, use its available width, and disable Connect until a nonempty key is supplied.
27. Make Generate full-width with a 24px diagonal arrow at the right, 13px vertical padding, and 16px horizontal padding.
28. Separate Settings sections with 28px vertical padding, use a 320px theme selector constrained to the available width, and show the filled account sign-in button, Inference heading, and small muted provider explanation.
29. Use the established medium-weight grid title, muted prompt, starting position, and spacing.
30. Place Pause or Resume after the title/prompt and before Edit.
31. Display model IDs in grid axes with copy feedback and a chain link icon, rotating icons together with row text.
32. Left-align column labels on a tinted background, using 8px vertical and 16px horizontal header padding and a narrow row-label strip of approximately 35px at normal scale.
33. Dragging a column boundary must resize that column by the pointer displacement, including when the initial grid fits the viewport, on desktop and touch devices.
34. Begin with columns at least 340px wide and rows at least 390px high, distributing additional desktop workspace across cells. Fit the whole table width on touch devices by scaling it uniformly, leaving unused workspace below a short grid.
35. Put output controls in a bordered group 8px from the top and right, with 10px rounding, 2px padding and gaps, and 36px buttons. Use diagonal expand arrows and a slash-containing code icon.
36. Use a 52px output footer with a top border, 9px vertical and 12px horizontal padding, muted 32px actions, a diagonal open-output icon, and token arrows following their counts.
37. Hide output footers while a cell is expanded and give the released space to the preview. Expanded content fills the workspace below the complete navbar, with controls at normal scale even when the underlying grid is zoomed. Expansion and collapse preserve the website browsing context, interactive state, and preview viewing state without reloading the output.
38. Use medium-weight Markdown headings, 24px preview padding, and clearance beside the first heading for the toolbar. Within grid cells, tables stretch across the preview with rows matching the grid's row height; in expanded views, tables use their natural content size. Scale the document to fit its natural width, including code and table content.
39. Center the generation spinner and Generating label together inside the cell.
40. Center Queued and Paused labels inside cells and omit an active spinner while paused.
41. Edit titles in an inline input occupying 40 percent of the title line, committing with Enter or blur and cancelling with Escape, without separate Save title or Cancel controls. Restore focus to the title action after cancellation.
42. Show the visible progress-count breakdown when hovering or focusing the progress bar.
43. Use a 490px publication dialog constrained to the viewport, with 32px desktop or 24px phone padding, a translucent backdrop, a 23px medium-weight heading, a filled primary Save action, and a borderless Cancel action, without a separate close icon.
44. Place output-format cards above Your grids on the home page, followed by Public grids. Omit the entire Your grids section when the user has no grids.
45. Place each grid-list format icon before its title, retain status at the right, and use unadorned dark titles with the established row spacing.
46. Place the icon-only billing refresh action beside its heading and combine input/output counts in one Tokens column with following arrows.
47. Use the small muted billing introduction and omit the unavailable-charge notice when its count is zero.
48. Keep navigation, theme, and dialog-close controls free of tooltips. Preserve contextual tooltips on output, grid, and axis actions that had them in the original interface. Copy actions retain their existing tooltip while pending and show success or failure feedback afterward, without an additional pending tooltip.
49. Keep the entire navigation popup above the generation progress bar, grid headers, resize handles, output controls, and expanded previews, including its padding and spaces between links. The progress bar occupies the navbar's bottom edge and must not paint across an open menu. Grid layers must remain below navigation while their internal ordering is preserved.
50. Preserve phone page spacing, including the vertical spacing between grid-list sections and stacked axis controls. Truncate untitled grid prompts to one line with an ellipsis, while explicitly saved titles wrap.
51. Keep the grid navbar's bottom border, 36px action buttons with 4px gaps, and a non-shrinking prompt-copy control. Stacked phone axes use 10px gaps.
52. Show a left chevron before Previous and a right chevron after Next in grid-list and billing pagination, retaining the text labels.
53. Opening a grid from a scrolled list must show the grid header at the top of the viewport, including on mobile browsers in desktop mode. Returning to the list through browser history restores its previous scroll position.
54. Keep chat drag handles muted, with grip icons inset within their badge-height containers. Dim the source row immediately when its handle is pressed, before movement, and restore its appearance when dragging ends or is cancelled. During dragging, show an insertion line in the destination gap, using the upper or lower half of a row to select the gap before or after it. Dropping inserts the message at that gap, including at the start and end of the history; clear the marker when dragging ends or leaves the editor. On touch devices, reveal a message's deletion control while its input is focused.
55. For chat messages containing more than five whitespace-separated words, tapping the deletion cross reveals a large red Delete button immediately to its left. Only activating that button deletes the message. Messages containing five words or fewer delete immediately. Dismiss the confirmation when focus leaves the message, Escape is pressed, or the history is edited or reordered.

See [README.md](README.md) for an introduction, [ARCHITECTURE.md](ARCHITECTURE.md) for architectural responsibilities and boundaries, and [DEVELOPMENT.md](DEVELOPMENT.md) for development and validation guidance.

## 1. Product

### Product goal

> we want to make anything possible in openrouter possible in the app, with warnings and disclaimers

Status: high level product goal that is not a requirement (not achieved yet).

### 1.1. Benchmarking model outputs

1. Slopgrid lets people submit a prompt and compare generated outputs in a two-dimensional grid whose row and column meanings they choose.
2. Support model and prompt-variable axes for every output type, generator thinking-effort axes for text outputs, and size, aspect ratio, quality, background, and input-reference axes for images. Judged outputs also support judge model and judge thinking-effort axes as specified in section 3.8.
3. Offer five output types in this order: Markdown, Image, SVG, Static website, and Chat completion. Image generation uses image-capable models; static websites may contain multiple files, which are served without server-side execution. Chat completion uses the MessagesSquare icon and accepts an ordered chat history with optional unfilled messages, using the same text grid dimensions and output controls. Each supplied message has an editable body and a clickable role badge cycling through system (red), user (blue), assistant (grey), and unfilled (purple). Allow insertion at any position, deletion, and drag reordering, with keyboard reordering available on the drag handle. Preserve message roles, order, and body whitespace through saving, Edit, and Fork, and expand grid variables within each message.

   The editor always offers the unfilled role. Selecting unfilled clears the body and replaces its input with "The model will fill this message with an assistant response." Switching back restores an empty editable input. Require a supplied message before the first blank; supplied messages require nonempty bodies. Allow histories without explicit blanks, consecutive blanks, and supplied messages after the final blank.

   Enable provider prompt caching for Chat completion requests, with stable routing per cell and explicit reusable history boundaries for providers that require them. Cache availability remains provider-controlled.

   Fill blanks sequentially within each cell, using only the preceding messages and earlier generated answers. Insert each answer as an assistant message and generate exactly once per blank. If the final template message is a supplied user, assistant, or system message, run one additional inference call using the complete filled history and append its assistant response. A template ending in an unfilled message finishes with that blank's response. Render the completed conversation as messenger-style bubbles without visible role labels: assistant messages on the left, user messages on the right, and centered system messages with a subtle red tint. Preserve Markdown formatting within each message and include trailing supplied messages. Use the same conversation view while streaming, when expanded, and when opening an output directly. Store the conversation as an ordered JSON array of objects containing role and content; raw view, copying, and download expose that JSON, with downloads using a .json extension. Label the raw-view return control "View conversation". Stream the completed prefix and current answer. Retain the partial conversation after failure, and restart from the first blank on retry. Saved inputs, Edit, and Fork retain the template rather than generated answers.

   Share the cell budget across all template calls, allocating the remaining allowance equally among remaining calls, including the final completion when needed. Account for the actual accumulated history and subtract reported cost or available usage-based estimates; reserve the allocated share when cost cannot be estimated. Keep provider-controlled token limits when metadata is unavailable. Aggregate usage across calls and keep thinking separate from the transcript. Later input lengths are unknown before generation, so preflight estimates reserve the cell budget and show the existing unavailable-estimate warning. Reuse requires valid reported input-token counts for every required call and every generated answer to fit its destination call allowance at current prices. Use the original output token limit when reported output usage is unavailable, and regenerate when a required call or input-token count is unavailable.
4. Show generation progress as it happens, retain completed results, and let owners publish their grids afterward.
5. Keep all calls needed to produce a cell's output within one generation attempt.
6. Apply sensible request and generation rate limits without imposing deadlines on accepted inference.
7. When a user action receives HTTP 429, show the rate-limit message, preserve their inputs and completed results, and leave the action available for an explicit retry. Validation, admission, and rate-limit rejection before a grid is saved must leave the user on the form without creating a grid.
8. Retrying the same grid-creation submission after a lost response or reload must recover the existing grid rather than create a duplicate. Once a grid is saved, open that grid even if generation cannot start or its startup acknowledgement is lost. Recover its current generation state before offering Resume, and do not restart inference merely by replaying creation.

## 2. Interface, navigation, and presentation

### 2.1. Visual language

1. Use a dim, slightly warm light theme and a subtly warm dark theme. Settings offers System, Light, and Dark; System is the default and follows system appearance. On desktop, show a sun icon in dark mode and a moon icon in light mode; activating it immediately switches to and saves the opposite theme.
2. Show the custom 5x5-cell SVG project mark to the left of the website name on every page, including mobile and touch devices at every width and orientation. Give the word "grid" the same accent color as the logo squares.
3. Use permissively licensed stock interface icons alongside official OpenRouter and GitHub brand assets. Brand icons must remain recognizable and uncropped.
4. Keep buttons consistent throughout the interface, with restrained borders, padding, and corner rounding. Secondary buttons, including the hamburger and theme controls, have no borders. Output-type cards should have larger icons and labels without excessively rounded corners.
5. Use concise, distinct headings and labels without repeating information already visible in the section.
6. Explicit theme changes use the polygon reveal from https://theme-toggle.rdsx.dev/, reversing direction for light and dark, regardless of motion preferences. Switch immediately when view transitions are unavailable.

### 2.2. Navigation and page layout

Show a small-text footer on every page except the grid page, with "source code" linking to https://github.com/klntsky/slopgrid and "follow @klntsky for updates", separated by a centered dot. Only "@klntsky" in the updates text links to https://twitter.com/klntsky.

1. The logo opens `/`, which combines output-format selection, Your grids when populated, and Public grids. Redirect `/grids` to `/`. Selecting a format opens `/create` with that format selected.
2. Keep navbar link labels uppercase, with readable desktop text and enough space for grid information. Use matching gaps between the brand, action buttons, and title/prompt group.
3. For navigation, use the primary input capability independently of viewport width or orientation. Touch-primary devices use a hamburger menu anchored close to its button and keep theme selection in Settings. Mouse-primary devices show navigation links directly alongside the theme toggle, including when secondary touch support is reported. Keep compact grid action buttons on the first navbar row where they fit. At widths of 480px or more, place the grid title, prompt, and byline in the center of that row between the logo and actions; below 480px, give that information a full-width second row.
4. Give "Your grids" and "Public grids" matching large heading styles. Keep separators only between grid entries in the lists.
5. Billing and Settings use the ordinary centered content-column layout.
6. Convey publication state through the available grid actions, placement in the public list, and a lowercase "published" label in the owner's grid list. Unpublished entries show their lowercase generation status.
7. A missing grid should show its 404 promptly without retrying. Keep the error message focused on the missing grid.
8. Connection loss appears as a small bottom-right label with a rotating preloader and must not shift page layout. Generation preloaders must visibly spin.
9. In the Public grids heading, show "See what others have created" after a centered dot, using a smaller font size than the heading. Introduce the billing history with "Each inference attempt appears here, including retries, failures, and cancellations. OpenRouter bills your account directly."
10. Failed grid-list requests offer a retry for the affected list without reloading the page. Failed GitHub sign-in and OpenRouter authorization show visible failure feedback and retain the corresponding sign-in or connection action for retry.
11. Paginate Your grids and Public grids independently with 20 entries per page, newest first and grid ID ascending for equal creation times. Show Previous, Next, and the visible range and total only when a list has more than one page. Disable unavailable directions and pagination while fetching. Preserve each list's page in the home URL through refresh and browser history navigation. Clamp pages beyond the available results to the last page, and omit Your grids when its total is zero.
12. Show grid lists on the initial home-page render and keep upcoming pages ready for navigation. Returning home from creation should reuse available list data. Keep owned data scoped to the requesting user.

### 2.3. Tooltips

1. Tooltips have consistent behavior and a pitch-black background with white text in both themes. Show them only on controls and indicators specified to have a contextual hint. Showing or hiding a tooltip must not shift the surrounding layout, including the cost and spent values. Keep tooltips within the viewport, outside clipping containers, repositioning as needed during scrolling and resizing. Support hover and keyboard focus. Escape dismisses either kind of tooltip without moving keyboard focus.
2. Use hints only to explain a non-obvious action, icon, or value, consistently across the frontend.
3. Explain the budget as "Used to calculate each output's token limit." Use the cost and spent hints specified in section 7.1.
4. Give token-arrow indicators "Input tokens" and "Output tokens" hints. Supported compatibility checkmarks do not get tooltips.
5. Budget hints use field-level interaction.
6. Use the current pause hint specified in section 6.3.
7. When Generate is disabled, its tooltip explains the current blocking reasons and works on hover and keyboard focus. Omit it when Generate is enabled.

### 2.4. Clipboard actions

1. Copy actions show pending, success, and failure feedback, announce their state to assistive technology, and retain a stable accessible action name. Prevent duplicate writes while a copy is pending and allow retry after failure. Apply this behavior to prompt, output, link, and model-ID copying.

## 3. Grid creation

### 3.1. Form and output selection

1. The creation-page call to action is "Create your own AI model benchmark". The layout heading is "Specify grid layout", followed by a centered dot and "what should be the rows and the columns of the grid?". Put fixed model, thinking effort, and image settings outside the row and column axes in a separate "Specify common parameters" section between the layout and prompt sections. Omit this section when it has no parameters, keeping subsequent section numbers consecutive. Arrange common Size, Aspect ratio, and Background inputs in a single row that wraps on smaller screens, with Quality and Input references below when present.
2. `/create` owns the complete creation form, including output-format selection. Opening it directly restores the saved draft or starts with SVG selected. Clicking the selected output type deselects it and returns to `/`, preserving the draft inputs. Clicking a different output type changes the selection within `/create`. Home always shows discovery independently of the saved draft, with all output types unselected. Preserve the creation page's scroll position on refresh and browser history navigation, while new route visits start at the top.
3. Preserve the in-progress setup through provider authorization and restore the applicable setup when editing or forking. These flows return to `/create`.
4. Put an icon-only swap button between the row and column selectors. It has no border and swaps axis types, selected values, and corresponding prompt-variable references together.
5. New image grids start with Model rows and Quality columns, with Auto as the only selected quality and no models selected. SVG and Website grids start with unselected model rows and thinking-effort columns with Model default checked. Markdown grids start with thinking-effort rows with Model default checked and unselected model columns. Restored drafts, Edit, and Fork preserve their saved layout and selections. Every generation must use an explicitly selected model, including when model is a fixed setting rather than an axis.
6. Grid creation has no application limit on prompt length, axis-value length, model-ID length, submission size, number of axis values, cells, or requested parallel workers. Accept these inputs subject to OpenRouter's limits. Actual concurrency follows the shared worker allocation policy.
7. Arrange short axis choices, including aspect ratios, size presets, quality, background, and thinking efforts, as inline checkboxes that wrap onto additional rows as needed. Keep each checkbox and its label together.
8. Clear the creation draft after successful grid creation so the next format selection starts a fresh setup. Preserve drafts through failed or unacknowledged creation attempts. Edit and Fork explicitly restore the selected grid's setup.

### 3.2. Model and thinking-effort selection

1. Model lists are filterable and alphabetically ordered, with a tall selection area that makes multiple options visible at once.
2. The filter has a magnifying-glass icon, the placeholder "Search models," and an always-visible clear cross.
3. Initialize model-axis searches to an empty string for Image and to `latest` for every other output type. Initialize the fixed-model search to `latest` for every output type. This filter must not select a model automatically.
4. Show selected models as removable badges under multi-model lists, including selections currently hidden by the filter. Model-axis badges support mouse and touch dragging and focused arrow-key movement to reorder selections. While dragging, highlight the insertion space between badges, including the positions before the first and after the last badge, and insert the dragged badge there on release. The insertion marker follows the pointer across wrapped badge rows. Insert each newly selected model beside the selected model closest to it in the complete, unfiltered list, before or after that neighbour according to catalog order. Resolve equal distances toward the earlier catalog entry and preserve the relative order of existing selections, including manual reordering. Neither the badge's model name nor its remove button has a tooltip. Removing a model does not focus the model filter; clearing the filter does.
5. Shift-click selects or clears a range of visible model checkboxes according to the clicked checkbox's new state.
6. Use the term "thinking effort." Order efforts by their semantic levels rather than alphabetically or by selection order, and let the effort selector expand to its full content height without an inner scrollbar.
7. A model or effort that is not an axis applies as a fixed selection to the grid. Use the same searchable model selector for the fixed model, with radio buttons allowing one selection. Keep "Model default" thinking distinct from automatic model selection: the former leaves the model's thinking configuration unspecified.
8. Make the complete model catalog, image pricing, and image capabilities available when the page first appears, and keep the catalog current.

9. Show right-aligned input and output prices per million tokens beside text models in both axis and fixed-model selectors. Tooltips show the full input and output rates and any published per-request charge. Preserve published zero prices, and show "Price unavailable" when pricing is missing.

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
2. All compatibility tables always have model names as rows and parameter values as columns, regardless of generation-axis layout. The thinking-effort table includes selected thinking efforts other than Model default, including fixed model or effort settings, without repeating combinations for prompt variables. Model default remains selectable but is omitted from the table because it is supported for every text model. Each image compatibility grid includes that parameter's selected values, including shared settings and reference groups. Check complete image settings against individual provider endpoints, including reference counts, and attribute combination conflicts only to the involved parameter types.
3. Use SVG checkmarks for supported combinations, yellow warning icons for unsupported combinations, and a question mark emoji for unknown support.
4. Do not show a tooltip on a supported checkmark. Image warning tooltips identify the incompatible parameter values or conflicting settings; unknown results identify which support information is unavailable. Each compatibility cell's accessible name includes its model, parameter value, and support status.
5. Thinking-effort and image-setting compatibility warnings are advisory and must not block generation. Send the selected settings and show an upstream rejection as a cell error if the provider rejects them. Judge model eligibility in section 3.8 is required, not advisory.

### 3.5. Budget and automatic parallelism

1. Text generation requires a per-cell monetary budget, defaulting to $3 per attempt. Preserve saved budgets. It covers estimated total cost, including input, output, and thinking. Image generation does not require a text budget; a missing or invalid text budget must not block image generation after a format change or draft restoration.
2. Label the compact field "Budget limit per cell," prepend a dollar icon, and reserve enough input padding to keep the value clear of the icon. It must not stretch across the form's full width.
3. Respect provider/model limits when translating the budget, without adding an unrelated fixed output-size ceiling. A retry gets a new attempt allowance. Missing pricing or token limits, including Auto Router metadata, must not block generation; the creation form's existing warning is sufficient. When a budget cannot be calculated, let the provider determine the output allowance for the selected model.
4. The creation form chooses parallelism automatically from available balance and estimated unfinished work, using conservative estimates when information is unavailable. Judging does not introduce displayed cost estimates or spending caps.
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

Image grids have a "Parameters" button with a 14px Info circle icon immediately after the prompt-copy icon, using the same muted color and borderless treatment. Clicking it opens a large panel styled like the tooltips and listing only common parameters: the fixed model, shared image settings, and shared reference thumbnails with filenames. Show unspecified scalar settings as "Auto" and empty shared references as "None". Reference thumbnails link to the saved image. The panel fits narrow screens and scrolls within the viewport. The button, close control, Escape, and outside clicks dismiss it, with keyboard focus returned to the button after Escape or the close control. It is available to both owners and published-grid viewers.

1. Either image axis can compare Size, Aspect ratio, Quality, Background, or Input references, alongside models and prompt variables. Keep the selected model explicit when neither axis contains models.
2. Size offers resolution presets and a Custom option that reveals separate Width and Height fields for pixel dimensions. A shared Size field has one pair; size axes support multiple pairs with controls to add or remove each pair alongside the selected presets. Both dimensions must be positive whole numbers before generation. Aspect ratio, quality, and background provide selectable values; capability warnings do not remove those choices.
3. Each Input references axis value is a group of user-selected image files sent together to each corresponding cell. Allow adding groups, editing their titles, adding files to a group, and removing individual files or groups, with image previews. Title editing uses the same interaction as grid titles: click to edit, Enter or blur to save, and Escape to cancel. Titles must be nonempty and distinct within the axis; renaming preserves the group's files, and titles persist through reloads, generation, editing, and forking.
4. Keep newly selected files in the browser until Generate is clicked. Retain the local selection across reloads and provider authorization for supported file sizes, and start uploading only on submission. Report local file-storage failures. Reuse uploaded references when editing or forking saved grids. If an upload fails, retry only the remaining files, including after reload.
5. Preserve image settings and selected reference groups with the grid. Settings affect inference parameters without being inserted into the prompt. A private reference is accessible to its owner or through an owned grid that uses it; publishing a grid shares only its selected references with viewers and forks.
6. Save reference images with the grid and format the corresponding row or column headers as "references: <title>" followed by tiny inline image previews in group order. Clicking a preview opens that reference in the full-page image view, with the same collapse and Escape behavior as generated images.
7. In the layout and common-parameter sections, show each reference group's heading as a pencil icon, editable group title, centered dot, and "reference image group". Its file-selection button shows a paperclip icon and "Add images".
8. Right-align OpenRouter's published output rates in the image-model checkbox list, preserving per-image and per-megapixel units and displaying token rates per million tokens. Show a range when published rates differ within the same unit, and keep different units separate. A tooltip lists provider names, additional charges, and pricing tiers. Missing prices display "Price unavailable". Rates are independent of the selected generation settings.
9. Reference uploads accept PNG, JPEG, and WebP images, with a maximum of 20 MiB per file. Reject other formats and oversized uploads with a visible error.
10. Removing a group's last image preserves the empty group and its title, including after reload. Generate validates that every selected group contains at least one image and shows an error for an empty group. Users may refill or explicitly remove the group.
11. For Image output, show separate configurable Size, Aspect ratio, Quality, Background, and Input references fields whenever they are absent from both axes. Scalar fields start at Auto, which leaves the choice to the provider; Auto axis values behave the same way. Shared references start empty and apply to every cell. Preserve shared settings and references through draft reload, authorization, Generate, Edit, and Fork.
12. Moving a configured image field into a row or column dimension transfers its value into the axis selection; shared references become one selected reference group. When a parameter leaves an axis, its separate field resets to Auto or an empty reference collection. Swapping axes preserves selections.

### 3.8. Judged output

1. Add optional judging as the numbered second-to-last creation section, immediately before "Inference provider setup", headed "Add a LLM judge" followed by a middle dot and "evaluates the output". Enable or disable judging with a checkbox slightly larger than inline checkboxes, using the existing themed checkbox styling, instead of separate add/remove judge buttons. Associate the complete heading label with the checkbox using its for attribute so clicking the heading toggles it. Keep this heading at the same viewport position when toggling adds or removes common parameters above it. Keep section numbering consecutive with or without common parameters. Checking creates one empty criterion with Correct answer Yes and the existing default judge settings: no selected model and Model default thinking effort. Disable this checkbox for Website output.
2. Display criteria in a table layout without headers or row separators. Each criterion has an editable question with placeholder "a yes-or-no question about the output." and a clickable badge toggling the boolean correct answer between green YES and red NO, defaulting to YES. The answer badge shares the role-switch badge styling and matches the initial single-line question-input height without growing with longer questions. "Add criterion" has a plus icon and appends an empty question with Correct answer YES. Reuse the chat history editor's move handles and pointer/keyboard reordering, moving the question and correct answer together. Reuse its deletion cross and flow: five or fewer whitespace-separated words delete immediately; longer questions require the inline "Delete" confirmation, dismissed by Escape, editing, or leaving the input. Removing the last criterion disables judging and unchecks the section header.
3. With a judge enabled, offer "Judge model" and "Judge thinking effort" as axes or fixed settings below layout in "Specify common parameters" when absent from both axes. Fixed judge settings use the same layout and spacing as other common parameters. Without a judge, disable its axes and omit its settings. Reuse searchable model selection, effort ordering, alias warnings, and advisory effort compatibility. Judge selectors use text-model pricing even for image grids, with "Search judge models" and "Clear judge model filter".
4. Preserve criteria text and boolean answers, including No, through draft reload, authorization, Edit, and Fork. Supported-format changes retain criteria and judge effort and clear an incompatible judge model. Selecting Website removes judging; show "Websites do not support a judge yet." Unchecking the judge checkbox resets only judge axes to that format's defaults. Moving a setting into an axis transfers its fixed value; moving it out retains its first value. Axis swap preserves selections.
5. Require at least one nonempty yes/no criterion, a boolean correct answer on every criterion, an effective judge model, valid efforts, and distinct non-variable axes. Judge models require text output and explicit structured-output support; SVG and Image also require image input. Unknown capability and response-format-only support are not sufficient. Website judging is unsupported. Image grids may use judge thinking effort but not generator thinking effort.
6. Use "Add at least one criterion." for an empty criteria table and "Enter a yes-or-no question for each criterion." for a blank question. Use "Select a judge model.", "Add a judge to use judge dimensions.", "No compatible judge models are available for this output type.", "The judge model must support structured outputs.", and "The judge model must support image inputs for SVG and Image outputs." for the corresponding validation failures.
7. Show "Judge calls are not limited by the generation budget." Do not inherit the generation budget or set a judge monetary/token cap or provider maximum price, and do not show live judge cost estimates.
8. For judged grids, show layout counts as "{R} rows x {C} columns - {G} generated outputs", where G counts distinct generation setups. Do not include a judgment count. Leave the existing Parameters popup unchanged; criterion results belong only in the cell's judgment popup.


## 4. Grid layout and metadata

### 4.1. Table geometry and gestures

1. The grid fills the page below the navbar, with the same overall layout during generation and after publication. Both row and column headers remain sticky, and the top-left corner cell is empty.
2. Rotate row labels 90 degrees counterclockwise and keep header/cell text readable. The row-label column should fit its contents.
3. Keep the first row compact in height and the label column compact in width through restrained header padding. Size output cells independently.
4. Page-height filling may expand output rows, but must never stretch the header row. Its height stays natural through viewport fitting, zoom, resizing, and restoration of saved sizes.
5. Users resize output columns and rows through their corresponding header edges. Each shared edge controls the column to its right or row below it, including the last output row. The header row and label column themselves are not resizable. Resizing permits column widths from 120 to 20,000 pixels and row heights from 160 to 20,000 pixels.
6. Remember output dimensions for each grid in the current browser without sharing size preferences with other browsers. Restoring output sizes must preserve the header's natural height.
7. Support pinch zoom whenever a touchscreen is present, regardless of screen width. Start by fitting the table to available width and prevent zooming out beyond that width fit. Limit zooming in to three times the table's unscaled size.
8. Keep one-finger scrolling usable, including within Markdown cells. Zoom the grid rather than the application navbar.
9. Click-dragging empty grid areas scrolls both axes. Drags starting on images, website frames, Markdown or thinking previews, interactive controls, and resize handles retain their own behavior. Image padding belongs to the draggable grid, while images retain their centered, aspect-ratio-preserving fit.

### 4.2. Title, prompt, author, and price

1. Title and prompt are separate values. A new title is empty. Grid lists use a custom title when set; otherwise, use an expanded prompt that replaces every $ROW and $COLUMN with the corresponding axis values in order, formatted as (value1|value2|...). Limit the expanded prompt to 160 characters, including a trailing "..." when truncated, without splitting Unicode characters. Older grids without an expanded prompt retain their original prompt as the fallback. Keep the original prompt for generation and the grid navbar.
2. In the navbar, show "Set Title" when the title is empty or the title when set, followed by a centered dot and the prompt. Owners can set or change the title independently of the prompt, including after publication.
3. Limit titles to 40 characters. Neither the title nor "Set Title" may be ellipsized.
4. Title text is dark in light mode and white in dark mode. Prompt text uses the same accent color as "grid" in the wordmark.
5. Collapse long prompts, with a hover element over the collapsed prompt showing the complete text.
6. Place an icon-only copy button directly after the inline prompt text; copying applies to the prompt only.
7. Show the author near the title, followed by "cost $0.NN" and, for the grid owner only, "spent $0.MM", separated by centered dots.
8. Truncate both grid totals to two decimal places in the UI. While generation runs, animate a gradient wave across the cost and spent text themselves. Judge-only work does not animate generation costs.

### 4.3. Progress and actions

1. Place the progress bar as a thin line under the navbar. Completed and failed cells both count as finished; failed segments are red and successful segments retain the accent color.
2. Show a pulsing spark moving left to right during generation.
   Pending cells in a paused grid display "Paused" without an active generation spinner; pending cells in an active grid display "Queued".
3. Put the pause/resume action after the title/prompt and before Edit. Edit and Publish are compact icon-only controls using the same visual treatment.
4. Before publication, Edit immediately cancels active inference and returns to parameter selection with the existing setup restored. Generating the edited setup creates a new grid and can reuse matching completed artifacts as specified in section 10.
5. After publication, offer Fork to restore the setup for modification and generation using the forking user's own connection. Its icon depicts a branch splitting from a continuing main branch.
6. Show model IDs in row or column labels. Clicking a model ID copies it without a hover hint, while preserving copy-result feedback; a chain icon to the right of its copy icon opens the model's OpenRouter page in a new tab. Copy and link icons follow the same orientation as the label text, including in rotated row titles. Prefix thinking values with "thinking: " and image parameter values with their lowercase display name and ": ", such as "size: 1K" or "aspect ratio: 16:9". Judge headers identify "judge model: " and "judge thinking: ", retaining model copy and OpenRouter links. Reference headers use "references: <title>". Keep generator model IDs and prompt variable values unprefixed.

## 5. Outputs and streaming

### 5.1. Shared controls and output preservation

1. Place icon-only Open output, Copy output, and Download output controls at the bottom left of cells as applicable. Open output opens a separate tab.
2. Copy copies the output content and is not shown for websites. Download saves a website as a ZIP containing its files and relative paths.
3. Download filenames follow `<prompt>.slopgrid.com.<grid-id>.<row_parameter>.<column_parameter>.<extension>`. Normalize filename components, replacing spaces and characters unsuitable for filenames with underscores. The domain in this pattern is product-facing filename text.
4. Preserve generated Markdown source verbatim. SVG previews and saved output must apply consistent, limited repairs for surrounding code fences, incomplete trailing markup, a missing root namespace, and unescaped ampersands in CSS, including comments. Preserve valid SVG markup and all other generated content.
5. Preserve generated output independently of metadata edits and publication, without an application output-byte limit.
   Show Expand and view controls when a cell has output or thinking content to inspect, is generating, or is already expanded. Omit them from empty queued, paused, and failed cells. Keep output links, copying, and downloading conditional on available output.
6. Treat an unsuccessful completion reason as a generation failure rather than silently accepting incomplete output. When reported thinking tokens exhaust the requested output-token limit without producing output, show "The model spent all of its <limit> output token limit on thinking without producing output - this is a common failure mode of some models indicating that the thinking level is too high for the task", substituting the actual limit (for example, 234K). Preserve its thinking trace and charges.

### 5.2. Markdown

1. Render Markdown formatting while displaying embedded raw HTML as text. Use consistent heading hierarchy, paragraph spacing, code backgrounds, blockquote styling, and theme-aware table borders. Reserve space for controls so they do not obscure content, and keep scrollbar space stable.
2. Render Markdown incrementally into the same rendered layout used for completion, retaining the preview and scroll position throughout.
3. Let code blocks take their full natural content width, then scale the whole Markdown document to fit the cell width. Scrolling is vertical only. Use a monospace font with equal advance widths for spaces and full-block characters and natural line spacing for rendered code blocks in grid previews and direct output pages. Use the same font for Markdown source views.
4. Add an icon-only raw-view toggle to the left of Expand. Raw mode shows the original Markdown as unformatted text in a monospace font, preserves line breaks, disables wrapping, and scales to the cell width.
5. In raw mode, the button becomes a Markdown icon that returns to rendered Markdown. Keep raw view available during streaming.
6. Put Expand in the top-right corner. Expansion occupies the grid workspace while keeping the navbar visible; collapsing restores the grid's layout and viewing state.
7. Open output carries the app's currently resolved light or dark theme into the standalone Markdown page, including when the app follows the system theme.

### 5.3. Images and SVG

The SVG generation prompt must require a well-formed standalone XML SVG document, prohibit all XML and CSS comments, and require XML escaping in text, CSS, and attribute values.

1. Display generated images and SVG as images that always fit the cell. Provide an icon-only Expand button that opens the output in the grid workspace while keeping the navbar visible. Collapse or Escape restores the grid layout, viewing state, and button focus. SVG previews continue streaming while expanded.
2. During SVG streaming, apply the same limited repairs as for saved output. Continue updating the preview while thinking is shown, and reveal the latest preview when switching back to output.
3. Do not reject SVG merely because markup validation considers it malformed or unconventional; browsers may still recover it.
4. Reuse available completed SVGs and images when revisiting or expanding them, without a repeat download.
5. Center images horizontally and vertically in ordinary cells and expanded views, retaining their aspect ratio. In ordinary cells, shrink images to fit and leave smaller images at their natural size, keeping the empty space available for dragging the grid. In expanded views, scale images up or down to fit the available space.

### 5.4. Static websites

1. Generate a static bundle containing `index.html` and optional supporting files of any extension, including files without an extension. Accept generated assets regardless of file type or contents and serve them statically without server-side execution. Bundle paths remain confined to that output's files.
2. Stream website previews as file contents arrive, including partial files. Show entry-page content before all supporting assets have arrived. Place the streaming "Generating" indicator on the left, clear of the token counts.
3. Load generated CSS, module scripts, and relative assets correctly inside private frames and when opening or reloading a direct output URL. Direct tabs render the website at its separate output URL without a frame wrapper. Live output hosts must allow normal browser capabilities, including network requests, storage, computed audio, WebAssembly, forms, downloads, popups, and permission-gated APIs. Browser permission prompts and cross-origin rules still apply. Preserve output authorization and prevent generated pages from reading, replacing, or modifying the user's application session.
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

### 5.6. Judgment results

1. The only inline judge UI is the scales icon followed by X/Y in the existing cell controls, including expanded cells. Y is the criteria count and X counts verdicts equal to their configured correct answers. Derive this score rather than persisting it. The completed accessible name is "Judgment: {X} of {Y} correct".
2. Clicking the control opens a compact "Judged output" popup listing criterion text, green/check "Correct" for a matching answer or red/cross "Incorrect" for a mismatch, and each judge explanation as plain text beneath its criterion. Results and explanations appear only in this popup, with accessible text as well as color. Support outside-click dismissal, Escape, "Close judgment", and focus return using the existing Parameters popup interaction pattern.
3. Until a validated result is available, show -/Y and neutral unresolved criteria, not a zero score or red/green results. Accessible labels and popup states are "Judge queued", "Judging...", "Judge paused", "Waiting to retry judging...", and "Judging failed: {error}". Unjudged cells have no scales control. Do not add a score panel, percentage, or verdict export.
4. One judge call evaluates every criterion in order and reports the actual yes/no answer, not whether it matches the expected answer. Do not send correct answers to the judge. Missing or extra results, invalid types, empty explanations, malformed output, and unsuccessful completion fail judging without repair or unstructured fallback. Use "The judge returned an invalid structured result." for invalid results.
5. Judge the saved Markdown text, completed chat JSON with legacy transcripts normalized, saved image bytes, or a server-rendered PNG of the committed SVG. Retain original SVG output and downloads. Render without browser or native fallback, external resource fetches, or local image resolution, using the bundled font, transparency, preserved aspect ratio, no upscaling, and a longest edge at most 2048. Report "Could not render this SVG for judging." when rendering fails, preserving the SVG and making no judge request. Missing committed output reports "The generated output is unavailable for judging."
6. Committed generation remains available for output, raw view, thinking, copy, and download while judging runs or fails, subject to ordinary access control. Cache ready output independently of judgment completion; cached verdicts remain snapshots, not offline inference.


## 6. Inference, scheduling, and recovery

### 6.1. Worker allocation

1. Share available generation capacity across users and their grids.
2. Aim to give each eligible user at least one worker when possible, then distribute capacity as evenly as possible. Give a newly freed worker to an eligible user with the fewest active workers.
3. Count a user's allocation across their grids. Respect requested grid/session concurrency ceilings as well as the global cap.
4. Do not cancel active work or reserve idle slots merely to rebalance. When limits change, allow existing work to finish while applying limits to new dispatches.

### 6.2. Balance, errors, and retries

1. Check available OpenRouter balance before starting or resuming inference. Image generation below $3 shows a top-up popup with an explicit Continue anyway option; that option uses automatic parallelism for new grids. Text generation uses calculated parallelism for new grids and OpenRouter's admission decisions. Existing grids retain their saved explicit counts on Resume. Fully reused unjudged grids require no inference balance check; fresh judging always requires inference admission.
2. Billing interruptions must let users fix the problem and retry repeatedly without breaking the flow. Preserve completed cells and regenerate only unfinished work.
3. Retry provider rate limits with increasing delays, honoring provider retry guidance while allowing other users' work to continue. Automatically retry temporary in-flight spending-limit billing errors only when OpenRouter supplies retry guidance; otherwise pause for user intervention rather than automatically retrying the billing failure.
4. Among provider errors, only pricing or billing errors may automatically pause queued batch work. Other provider failures, including age verification, model access restrictions, and invalid or missing credentials, fail only their affected cells while other cells and grids continue. Preserve the provider explanation on each failed cell. Recoverable infrastructure persistence failures suspend new dispatch as specified in section 9.
5. Propagate provider error messages and codes to the client and retain them with failed cells, including after reload and publication.
6. Ongoing generation continues regardless of elapsed time until it finishes, fails, or the user cancels it.
7. Recognize exhausted OpenRouter key, workspace, and guardrail budgets reported as HTTP 403 as billing interruptions, while other permission errors affect only their cells.

### 6.3. Pause, resume, and updates

1. Pause immediately cancels active generation for that grid, removes queued work, and discards unfinished output previews. Completed outputs remain intact. Pause and Edit must remain effective even when saving is temporarily unavailable. Interrupted unfinished work remains available for explicit Resume after a restart.
2. Resume restarts unfinished cells, including retries, while preserving completed outputs. It must remain possible after dismissing an interruption popup.
3. Use a red stop-square icon for the stop/pause action and the hint "Work can be resumed later, unfinished responses will be lost".
4. Keep the grid updated while queued or active generation, cancellation, or saving can still change its results or charges. Reloading or reconnecting must recover the current state and continue receiving updates. A storage failure must not unnecessarily stop authorized live progress or present unsaved completion as durable. Deny access when authorization cannot be checked.
5. Delayed updates must not move title, output, thinking, status, or price backward, including after a restart. Retries must show content from the current attempt.
6. Interrupted unfinished work requires an explicit Resume, preserving completed outputs.

### 6.4. Shared generation and durable judging

1. For judged grids, generate once per distinct generator setup and use the identical committed artifact in each member cell. Judge comparisons do not create additional generation calls. Waiting members consume no generation workers; each judgment uses ordinary worker allocation independently.
2. Generation failure affects dependent cells; judge failure affects only its judgment. A false verdict is successful judging, not an inference error. Overall cell completion waits for judging, and publication follows the existing unfinished/failed-cell policy.
3. Preserve committed generation and completed verdicts through Pause, recovery, and Resume. Resume retries only unfinished stages, including incomplete member copies repaired from the committed representative instead of generating again. Preserve temporary-error retries and billing pauses without duplicate requests after cancellation or storage retries.
4. New grids always need fresh judgments. Reload, Resume, and duplicate creation replay do not repeat completed verdicts. Do not cache verdicts or reuse judgment attempts or usage across grids.


## 7. Costs and billing

### 7.1. Per-cell and grid prices

1. Show cost information per generation. Display input tokens with an upward arrow and output tokens with a downward arrow, using `$` without a redundant USD suffix.
2. Show running input and output token counts alongside each text cell's running price, using the same layout and arrows as final counts. Estimate usage from input, visible output, and available thinking while streaming, mark estimates as approximate, and replace them with provider-reported usage when the call completes. Use a monospace font for the per-cell counts and price to reduce text movement.
3. The cost total is the sum of successful generation outputs currently shown on the grid plus running generation estimates. Deduplicate shared generation, including when judgments are pending or failed.
4. The spent total is the sum of all reported generation charges for this grid plus running generation estimates, including failed, cancelled, and retried generation calls. Replace each running estimate with its reported charge without counting the attempt twice; discard its estimate when work stops. Judge charges belong only in Billing and do not change grid Cost, Spent, token counts, or estimates. Show spent only to the grid owner and omit it from responses to other viewers.
5. Keep both totals' two-decimal UI truncation separate from stored billing precision. Cell charges and billing amounts use two to eight fractional digits, distinguishing unavailable costs from zero. Display a positive charge below the precision limit as "<$0.00000001" so it is never shown as zero.
6. The cost tooltip is "Generation costs for this grid, not including failed attempts". The spent tooltip is "Generation costs for this grid, including failed attempts".

### 7.2. Billing history

1. Provide a separate billing page that records every actual inference call, including retries, failures, and cancellations. Do not include unbilled catalog, balance, or OAuth calls as inference charges.
2. Attribute each call to its grid and provide a link to that grid. Show the call's local start timestamp, model, thinking effort, and provider error code alongside its error message when available.
3. Retain reported charges for unsuccessful calls. Do not turn missing provider cost information into an invented zero charge.
4. Billing follows ownership: anonymous users see their session's history, and signed-in users see their account-owned grids' history, including grids claimed on sign-in.
5. Keep provider finish reasons out of the current UI.
6. Show an aggregate reported-charge total and call count, including the count of calls with unavailable charges. Provide a manual Refresh billing control and a Call column showing each call's `direct`, `image`, or "Judge" phase. Judge entries show their actual judge model and thinking effort, including retries and failures. Present 50 calls per page with Previous and Next controls and the visible range and total, showing pagination only when there is more than one page. Refresh automatically while calls are running and disable manual refresh while fetching. Show loading and empty states. Keep the table horizontally scrollable on narrow screens and truncate long grid links within it.

## 8. Identity, publication, and access

### 8.1. Anonymous and GitHub accounts

1. Users are anonymous by default. Offer recognizable GitHub sign-in in the interface. Settings contains an Account section with sign-in when anonymous, or linked GitHub identity and sign-out when signed in, accessible on both touch and mouse devices. Show account-loading and retry states when session lookup is pending or fails.
2. A GitHub identity displays as the GitHub icon followed by a username linked to the profile. Otherwise display "by Anonymous". Show authors near grid titles and in public grid listings; omit authors from the owner's own grid list.
3. Account ownership persists when a GitHub username changes. Refresh display identity on sign-in.
4. On sign-in, atomically claim the current anonymous session's grids for the account, including their billing history. Never claim another account's grids.
5. Account grids and billing are accessible across browsers signed into that account. Signing out removes account access; newly created anonymous grids belong to the current anonymous session.
6. Preserve the initiating inference connection during identity changes so signing in or out does not silently replace credentials or interrupt accepted work.
7. Freeze author attribution at first publication. Later claims, sign-ins, or profile changes must not rewrite a published grid's author; unpublished grids may show the current identity.
8. Preserve access across browser restarts without periodic sign-in for as long as the browser permits, until the user signs out or access is revoked. Clearing browser session data removes that browser's access.

### 8.2. Inference credentials

1. Keep OpenRouter connections browser/session-scoped; do not attach them to the GitHub account or copy them to other browsers.
2. Remember manually entered keys only in the current browser. The server may use them for connection checks and generation but must not retain them after they are no longer needed for execution.
3. Support OpenRouter OAuth connections alongside browser-stored manual keys, with each flow's credential lifecycle handled independently.
4. Public responses must not expose credentials, session ownership tokens, or private runtime data.

### 8.3. Publication and discovery

1. New grids are private. Publish opens "Control who can see this grid" with radio choices "Keep private," "Accessible by link," and "Listed publicly," plus Save and Cancel.
2. Saving Keep private closes without publication. First publication requires confirmation, with Confirm, Cancel, and a "Don't ask again" preference remembered in this browser only after successful confirmation. Failure to save browser preferences must not block publication.
3. Use this confirmation text: "This projects aims to facilitate model benchmarking and research, and we don't want valuable data to disappear. For this reason, making a published grid private is impossible."
4. Publication is allowed when every cell is complete or failed, or when the grid is paused with unfinished cells. Published unfinished cells without committed output appear as failed with the error reason "Not generated" and no error code. Preserve committed outputs, judgment state, and existing failures. Running cells prevent publication; published grids cannot resume inference.
5. Publishing permanently locks generation inputs and outputs and prevents returning to private visibility. Public grids cannot be deleted so that benchmark data remains available. Title editing remains allowed independently.
6. Provide an owner-visible route and control to promote an already link-accessible grid to public listing. A publicly listed grid cannot be demoted to link-only or private visibility.
7. Link-accessible grids are readable by anyone with the link but excluded from public discovery. Public grids appear newest first on the home page beneath Your grids when present, or directly below output-format selection otherwise, including the owner's own public grids.
8. Give public discovery its own loading, empty, and failure states, and refresh relevant lists after publication. Show format icons and authors without exposing ownership/session identifiers or nesting profile links inside grid links.
9. Retain copy-link and fork controls for published grids. Dialogs must support keyboard operation, focus restoration, disabled controls while saving, and visible request errors.
10. Public grids may have an optional, globally unique slug claimed by the owner when publishing or afterward if no slug has been claimed. Slugs contain only lowercase Latin letters, digits, and hyphens, with at least one hyphen. A claimed slug is permanent and cannot be changed or removed. Slug links use the root path, such as `/my-cool-grid-1`. Existing grid links remain accessible, while listing links and Copy link use the slug when present. A failed slug claim must not publish the grid.
11. Validate slug naming as the user types, display errors below the field, and reserve error space so typing does not shift the layout. Leave an empty optional slug valid and disable Save while naming is invalid. Use this naming error text exactly: `Use latin characters, numbers, and at least one hyphen. Example: "my-grid1"`. Prepend a fixed `slopgrid.com/` prefix to the editable slug field.
12. Place the slug field beside "Listed publicly:" with "your-chosen-slug" as its placeholder after the fixed `slopgrid.com/` prefix, wrapping below the radio choice on narrow screens. Match the input height to the other visibility rows. Use one border and focus indicator around the prefix and editable value; clicking the prefix or field padding focuses the input and selects public visibility. Keep validation text compact below this row without an error banner or extra reserved space beneath the message.

### 8.4. Output isolation and private access

1. Private output belongs to the owning user account and is accessible from any live session signed into that account, including direct output links in another browser. Anonymous grids remain accessible through their anonymous browser identity until claimed on sign-in. Knowing a grid, output, preview, download, or thinking URL does not grant access to another user or an unauthenticated visitor.
2. Enforce ownership and session access for every output format, website asset, preview, download, and thinking trace. Retain offline copies of visited ready outputs and pages for the current session. Sign-out and observed session changes clear those offline copies. Offline access cannot observe remote session revocation until reconnection.
3. Isolate generated websites from the application and from other outputs. Offline website copies must not make network requests.
4. Generated HTML must not access or modify application sessions or another output's private data. Retain isolation while allowing its static scripts and assets to render.
5. Generated websites can access only their own bundle's files.

## 9. Availability and updates

1. Web and interface updates must preserve accepted inference, including queued work, output, thinking, and charges. Browsers reconnect automatically after a brief connection interruption.
2. An inference-machinery update stops accepting new work and lets accepted grids and unsettled calls finish without a cancellation timeout. Cancelling maintenance restores admission.
3. Open browser tabs retain access to their frontend assets across updates. Routine deployments preserve grids, outputs, credentials, and sessions.
4. Temporary storage failures pause new generation while preserving accepted work and its results. This includes later provider calls within an active Chat completion; wait for billing writes before issuing another request, and allow Pause to cancel the wait. Continue automatically after recovery unless the user has paused or maintenance is underway. A storage interruption must not require manual Resume or cause duplicate provider charges.
5. Recovery from disk-full errors is outside the supported failure-recovery scope.

### 9.1. Progressive web app and offline navigation

1. Make Slopgrid installable as a progressive web app.
   Use the dark-theme background and logo colors for its SVG app icon.
2. Cache every ready output the user visits, across Markdown, Image, SVG, and Static website formats. Cache the supporting files needed to view a ready website output.
3. Exclude outputs still being generated from the offline output cache. A visited output becomes eligible when generation completes.
4. Cache fetched pages and their fetched data so the user can navigate those pages offline, including fetched grid-list pages and visited grids.
5. Refresh data and resume live progress after reconnection. Keep authentication exchanges and inference mutations out of the offline cache, and do not queue mutations for automatic submission after reconnecting.
6. Use `slopgrid` as the installed app name and `Generate and compare AI outputs in a grid.` as its description. Use `This page isn't available offline.` and `This output isn't available offline.` when the respective cached content is unavailable, with `Retry` for retry controls.
7. Keep cached content replaceable: evict older cached data when a quota error prevents a write, and preserve online operation when storage is unavailable. The server retains the original grids and outputs.

## 10. Reusing completed artifacts

1. Edit and Fork retain the source grid through draft reloads and provider authorization. Above Generate, show "Reuse existing artifacts from the previous version", checked by default, with the tooltip "Copy existing artifacts with matching generation settings that fit the token limit". Hide this checkbox for creation without a source, and regenerate every cell when it is unchecked. Connection requirements apply even when all generation can be copied; balance checks follow section 6.2.
2. Search only the selected accessible source grid, including owned private grids and other users' published grids. Reuse committed generation with matching settings that fit the destination's computed token limit, choosing the first eligible cell in grid order and one source artifact per destination generation group. A source judge failure does not prevent output reuse. Generate again when the original generation settings cannot be established or the output or thinking is unavailable.
3. Reuse requires equivalent generation settings, including output format, model, expanded prompt, thinking effort, image settings, and ordered reference content. For text, the output and thinking must fit the destination's token allowance. When usage is unknown, the original allowance must fit instead. Changing only the budget does not prevent reuse if the output still fits. Positions, titles, reference filenames, and parallelism do not affect matching; labels that change the expanded prompt do. Auto and unspecified image settings are equivalent, and image generation ignores text thinking settings.
4. Copies remain independent of the source and follow the destination's ownership and publication rules. Copied unjudged cells appear complete immediately; judged copies retain committed generation and wait for fresh judging. An entirely copied unjudged grid completes without inference calls. Preserve reported generation usage and original artifact costs in Cost; copies add no generation billing entries or Spent. Never copy verdicts or judge attempts/usage.

5. Reuse must preserve per-cell generation failures: an insufficient cell budget affects that cell without rejecting creation of the grid. Missing pricing does not prevent generation or reuse. When the destination has no calculated token limit, matching completed artifacts can be reused without a token ceiling check.
