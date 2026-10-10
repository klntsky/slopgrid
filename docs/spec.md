i want to turn this ui into a product

https://static.simonwillison.net/static/2026/gpt-6-and-5.6.html

called slopgrid

people submit their prompts and it generates output for a bunch of generation options (the user selects them): models, reasoning levels, or harnesses

generate the outputs on a server, and let the user publish their results after generation. Openrouter key billing errors must be processed so that the user could continue if interrupted.

i want 4 output modes:

- svg
- markdown
- index.html (genrrates arbitrary content, basically a file folder that will be served later, only static content, no server side code. can be multiple files)
- image (for image models)

grid layouts should be selectable (the user decides what rows and columns mean):

- model
- thinking effort
- variable prompt part - for template prompts - can be referenced in the prompt as $VARIABLE_{ROW|COLUMN}, will be string-replaced. If there are two variables (rows and columns), $VARIABLE_ROW and $VARIABLE_COLUMN can both be used in the prompt.

# pages

## Create a grid

A questionaire with questions, answering each one shows the next one, without hiding the previous:

- what do you want to generate?

(Options for output format)

- Select grid layout

(options depend on the previous step)

- Enter your prompt

- Key setup (openrouter oauth only for now)

[ Generate ]

## generation in progress page

layout same as published grid page, but incomplete generations show loading indicators. billing flow interruption should cause a popup, and generations that have completed should not be restarted after billing problem is fixed. make sure that if the user accidentally does not fix the billing problem, the flow does not break and they can retry once more.

## published grid page

both rows and colums should be sticky. If you struggle with this requirement, check how token.menu does that in their layout

## settings page

openrouter oauth for inference

# color theme

dim light, slightly warm colors

# stack

## frontent

typescript, react, tanstack, sse for streaming updates as they happen

## backend

ai sdk on the server
sqlite
sensible ratelimits

## safety

arbitrary HTML bundles should be served from separate hosts. Images, Markdown, and SVG should use the application host. output hostnames should use a configurable suffix that keeps each production hostname within one DNS label, so a wildcard certificate can cover them. ensure the cookie policy is set up so that separate htmls never see each others cookies

development rules:

never editorialize the user-facing text. when you create new UX surfaces, summarize the user facing texts in the chat for me - I care deeply about the things the user see
