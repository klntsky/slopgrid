# slopgrid

Slopgrid lets you compare AI-generated outputs side by side. Build a grid of models, thinking efforts, or prompt variations, then watch them produce Markdown, images, SVG, or static websites using your OpenRouter account.

## Create your first grid

1. Open **NEW GRID** from the grid list and choose an output type.
2. Choose what the rows and columns represent, then select the models, thinking efforts, prompt values, or image settings to compare. Image grids can also compare groups of reference images; files stay in your browser until you select Generate.
3. Enter your prompt. If an axis uses prompt variables, include `$ROW` or `$COLUMN` where its values should appear.
4. Connect OpenRouter or enter your own API key. For text outputs, set **Budget limit per cell** (default $5), adjust the requested parallel workers if needed, and select **Generate**.

Outputs appear as they stream. You can expand Markdown, switch to its raw source, inspect available thinking with the brain button, and open or download results. Website downloads contain the full bundle in a ZIP.

Pause stops unfinished work; Resume starts those cells again while keeping completed results. If a billing problem interrupts generation, you can fix your OpenRouter connection or balance and retry unfinished cells.

## Keep and share your results

Grids start private. Once all cells have finished, including any failures, use **Publish** to make a grid accessible by link or list it publicly. Publication is permanent: you can still rename the grid, but its prompt, selected reference images, and outputs become fixed and it cannot return to private visibility. Use **Fork** to create a new comparison from a published grid's setup.

You can use Slopgrid anonymously or sign in with GitHub. Signing in adds this browser's anonymous grids to your account so you can access them and their billing history from other browsers. Each browser needs its own OpenRouter connection; manually entered API keys stay in that browser.

## Track spending and preferences

**Cost** combines successful results with estimates for work in progress. Owners also see **spent**, which includes all recorded charges for that grid, including failed and retried attempts, plus running estimates. **Billing** shows the individual inference charges.

Open **Settings** to manage your OpenRouter connection and choose System, Light, or Dark appearance. Select the Slopgrid logo to return to your grids and browse public comparisons.
