# slopgrid

> Create your own AI model benchmark: generate multiple LLM outputs at once and compare them side-by-side

Slopgrid is a browser-based application for comparing AI-generated outputs side by side using your OpenRouter account.

## Comparisons and output formats

A grid has two dimensions whose row and column meanings you choose. Comparisons can vary models, prompt variables, complete input cases, and thinking efforts where supported. Image grids can also compare image sizes, aspect ratios, quality levels, and backgrounds. Available combinations depend on model and provider capabilities.

The supported output formats are:

- Markdown, displayed as formatted text.
- Image, generated with image-capable models.
- SVG, displayed as vector graphics.
- Static website, generated as a bundle of files without server-side execution.
- Chat completion, generated from ordered chat histories or templates with messages for the model to fill.

Prompts and user chat messages can include image attachments. Completed outputs remain available as generation progresses. Grids support pausing and resuming unfinished generation.

## Accounts and inference prerequisites

Users start with an anonymous browser session. GitHub sign-in is optional and provides access to account-owned grids across signed-in browsers.

Generation requires an OpenRouter connection through OAuth or a manually entered API key. OpenRouter connections are browser/session-scoped, separate from GitHub identity. New inference calls require access to the selected models and sufficient OpenRouter allowance. OpenRouter bills your account directly.

## LLM judging

Optional LLM judges evaluate Markdown, Image, SVG, and Chat completion outputs against yes-or-no criteria and expected answers. Judge models and thinking efforts can be compared in the grid. Results include criterion verdicts and row and column scores based on completed, valid judgments. Static website outputs do not support judging.

Judge calls are not counted toward the generation budget.

## Sharing and privacy

New grids are private and accessible only to their owner. Knowing a private grid or output URL does not grant access.

Owners can publish a grid as accessible by link or listed publicly. Anyone with a published grid's link can read it. Link-accessible grids are excluded from public grid listings, while publicly listed grids appear on the homepage. Publishing also shares the grid's attached images.

Publication locks generation inputs and outputs and cannot be reversed to private visibility. Publicly listed grids cannot be demoted to link-only visibility or deleted.

Published grids have copy-link and fork controls. Forking restores the grid setup as an editable draft for generation using the forking user's own OpenRouter connection.

## Links

- [Slopgrid homepage](https://slopgrid.com/)
- [LLM discovery reference](https://slopgrid.com/llms.txt)
- [Source code and README](https://github.com/klntsky/slopgrid)
