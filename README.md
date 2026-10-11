# slopgrid

Compare generated outputs in a grid. Choose models, thinking effort, prompt variables, or harnesses, then generate SVG, Markdown, static websites, or images using your OpenRouter account.

## Create a grid

1. Select the slopgrid logo to open your grid list, then select **NEW GRID** and choose the output format. On mobile, open the hamburger menu to find **SETTINGS**.
2. Choose what rows and columns represent, then select their values. Filter model lists by name or ID to find the models you want to compare. Selected models appear as badges below each model list; use a badge’s cross to remove that model, even when it is hidden by the filter. Thinking effort axes follow effort order rather than selection order. For prompt variables, enter one value per line. Image grids support models and prompt variables.
3. Enter your prompt. Use `$VARIABLE_ROW` and `$VARIABLE_COLUMN` to insert each cell's row and column values when those dimensions are prompt variables. Each enabled variable must appear in the prompt before you can generate.
4. Connect OpenRouter and select **Generate**. If your OpenRouter balance is below $3, top up from the popup and select **Check balance again**, or choose **Continue anyway** to run one generation at a time across your grids. The same check applies when resuming; a balance of $3 or more restores normal parallel generation.

When model, thinking effort, or harness is not a dimension, its selection applies to the whole grid. **Model default** lets each model choose its own thinking configuration. Before generation, Slopgrid checks every selected model and effort against OpenRouter’s published capabilities. Warnings name each incompatible model and setting, list supported alternatives, but let you generate with the selected settings anyway. OpenRouter may reject unsupported settings, which appear as cell errors. **Model default** leaves thinking settings to the model when effort information is unavailable. **Single pass** makes one request per cell. **Draft and review** generates a draft and makes a second request to check and revise it. A grid can contain up to 64 outputs, with up to eight values per dimension.

Model aliases with an exposed target are resolved when you generate, and only the concrete model IDs are saved. Edit, Fork, and retries reuse those IDs, even if the alias later changes. If an alias and its target are both selected on the same axis, they become one model entry. Aliases without an exposed concrete target cannot be used; choose a versioned model instead.

## Watch generation

The grid fills the page below the header, which shows your prompt, a generation progress bar, and publishing controls. Outputs generate in parallel as capacity becomes available, with free capacity going to users currently running fewer outputs. The progress bar has one segment per output in grid order: completed outputs use the normal accent color, failed outputs appear red, and unfinished outputs remain unfilled. Both completed and failed outputs count toward progress. The grid updates as generation progresses. SVG cells show a partial image while generation is running, completing unfinished markup for the preview and replacing it with the final output when ready. Completed outputs remain available when you reload the page. Row and column headers stay visible as you scroll. Drag a column label’s left edge or a row label’s top edge to resize that output column or row. Each shared edge controls the column to its right or the row below it, including the last row. The heading row and label column keep their automatic sizes, while output sizes are saved separately for each grid in this browser. You can also focus an edge and use the arrow keys, holding Shift for larger steps. Select the **Open output** arrow icon to view a result in a separate tab. Click or tap the model ID in a row or column label to copy its full ID; the chain icon beside the copy icon opens the model’s OpenRouter page in a new tab.

On devices with a touchscreen, the grid starts scaled to fit the available width, regardless of screen size. Pinch with two fingers inside the grid to zoom the table, then swipe with one finger to scroll. The header stays at its normal size, and zooming out stops when the table fits within the available width and height. Zoom resets to fit the width when the grid viewport changes size. Website and Markdown previews let these gestures reach the grid; use the **Open output** arrow icon to interact with a generated website or scroll a Markdown document separately.

The total reported cost appears beside the grid title, with animated dots while generation runs, and updates as outputs complete. It includes only the latest attempt for displayed completed or failed outputs, excluding unfinished outputs, unavailable charges, and earlier retry attempts. Each completed cell shows input tokens with an upward arrow, output tokens with a downward arrow, and its OpenRouter-reported cost in dollars; draft and review includes both requests. If any request lacks a reported charge, the cost is shown as unavailable. Calls that end unsuccessfully appear as cell failures, and their reported costs remain included in the grid total. Unreported charges and previous retry attempts are not included.

Use the pause button beside the prompt to stop unfinished requests and discard partial previews, then select resume to generate the unfinished cells again. Completed outputs are preserved.

Temporary rate limits and in-flight spending limits retry automatically, with up to five retries per unfinished cell and increasing waits that honor the provider’s retry delay. Waiting cells show **Waiting to retry…** and the provider’s error code and message. Other users can keep generating while your requests wait, and Pause stops queued retries. Retries restart the unfinished cell, including both passes when using draft and review, while completed outputs remain unchanged. Failed cells retain their error code and message after reload and publication.

If OpenRouter reports a billing problem, check your credits and key spending limit, then select **Retry unfinished cells**. You can close the popup and resume later using the button beside the prompt. Completed cells are saved and are never regenerated by retries. If OpenRouter rejects your key, reconnect OpenRouter. Work interrupted by a server restart also requires an explicit resume.

Before publishing, select the pencil button (**Edit**) to return to parameter selection with the current setup and prompt restored. This immediately cancels active inference and discards partial results. Generating from the edited setup creates a new grid; the previous grid remains in **YOUR GRIDS** with its completed outputs.

## Publish and share

Select the upload button (**Publish**) after every output has finished, whether it succeeded or failed, then **Copy link** to share the grid. Failed cells remain visible in published grids. Publishing makes the prompt, dimensions, and outputs accessible to anyone with the link. Published grids cannot be changed. Select the fork button (**Fork**) to copy a published grid’s setup into the parameter form, change its settings or prompt, and generate a new grid using your own OpenRouter connection.

Select the slopgrid logo to find grids created in this browser; the grid list also has a **NEW GRID** button. Keep that browser's cookies: ownership is tied to a 30-day browser session, with no separate slopgrid login or cross-device account. Each completed output has an unguessable URL that can be opened directly; anyone who receives that output URL can view it, even before the grid is published.

## Billing history

Open **BILLING** to see every recorded inference attempt, including automatic retries, failures, cancellations, and separate draft and review calls. Each entry identifies its grid by the prompt and links to it and shows its status, reported token usage, cost, and any error code and message. The total includes all reported charges in this history; missing charges are marked unavailable rather than counted as free. History is private to this browser session and begins when call recording is enabled; earlier requests are not reconstructed.

## OpenRouter settings

Open **SETTINGS** to choose **System**, **Light**, or **Dark** appearance. **System** is the default and follows your device’s current preference; explicit choices are saved in this browser and also apply in other open tabs.

The OpenRouter row shows your connection status. Select **Connect** when disconnected; once connected, use **Disconnect** or **Change connection** in Settings. On the creation page, the connected row links to Settings. While the connection is being checked, the row shows that status, and a failed check offers **Check again** without claiming that you are disconnected. Generation uses your account's credits. Disconnecting prevents further requests; an already-running request may still finish.

Generated websites run in an isolated sandbox. Static HTML, CSS, and JavaScript are supported; server-side code, network requests, forms, and browser cookies are blocked. Images and SVG render as images, with SVG scripts and external resources disabled. Opening an SVG output directly retains script and cookie restrictions, while Markdown previews also disable scripts and cookie access. Raw HTML in Markdown is shown as text.
