# Repository instructions

1. Use only ASCII characters in documentation unless the user explicitly requests non-ASCII characters in those documents. Before finishing, check modified Markdown documentation for non-ASCII characters and replace them with ASCII equivalents while preserving meaning.

2. Run only tests covering features actually changed, and skip tests for simple changes such as wording, styling, and documentation. Run affected automated and manual tests against an isolated candidate worktree and runtime, never against shared staging or production state. Keep GitHub CI disabled while preserving its workflow file. Before production deployment, run the complete unit, mock browser, and real-provider browser suites against the isolated candidate revision and runtime.

3. Keep README.md focused on a brief product introduction, a grid screenshot immediately after the first paragraph, useful features, and supported grid dimensions grouped by output type, without usage instructions.

4. When the user supplies literal text for documentation inclusion and asks to fill gaps, preserve the supplied text exactly and fill only the gaps.

5. Always commit and push together in one shell command using `git commit ... && git push`.

6. When the agent starts a background task, run its top-level command in tmux session `bg` so the user can inspect it. Application code, test runners, and CI manage their own child processes without requiring tmux.

7. Use the LLM patch tools for text edits, and never use Python for string replacement.

8. Keep ARCHITECTURE.md focused on architectural responsibilities and boundaries; leave granular styling details such as individual breakpoints in the code. Organize it with descriptive headings, short paragraphs, and bullet points grouped by responsibility instead of dense implementation inventories.

9. remember to never editorialize anything I say anywhere - not in the docs, not in the UI, not in your responses when citing

10. Before deploying the PWA changes, present all proposed written descriptions and new visible text to the user and obtain approval.

11. Keep deployment implementation in `ops/` and use its single `ops/deploy.sh` command. Run `validate [REV]` for isolated committed candidates without deploying a shared runtime. Invoke it from the candidate application worktree to select that worktree's HEAD by default. Production remains a single runtime, and its resolved revision must equal the authoritative remote `master` tip; historical master commits and divergent feature commits are not publishable. The pipeline checks this before upload and again remotely before production changes, including when tests are explicitly skipped. Configure `OPS_MASTER_REPOSITORY` and all infrastructure values in the ignored repository-root `.env`, and provide Git read access on both initiating and remote hosts. The command owns builds, isolated validation, mode selection, promotion, and final status. Production runs full isolated validation unless explicitly skipped after the complete candidate suites pass; `production --skip-tests` does not bypass the master gate. Staging is an explicit administrative deployment, not a common testing target. Do not create per-task deployment scripts, patch installed deployment code, or manually fabricate status files. Never commit infrastructure values or secrets. Update the pipeline when infrastructure changes.

12. Keep current product requirements, including UI behavior and visible text, in PRODUCT.md. Structure requirements with meaningful numbered items and bullets for human readers. Specify functional behavior rather than lists of things not to add. Keep architectural responsibilities and system boundaries in ARCHITECTURE.md. Implementation details belong in the code and do not need documentation; remove them from product requirements without moving them to another document. DEVELOPMENT.md is for humans: edit it only when a development-environment change needs explaining, not to add feature inventories, test inventories, or validation procedures. Keep agent instructions and workflow rules in AGENTS.md, and keep README.md within the introduction scope defined above. Do not duplicate product requirements in ARCHITECTURE.md or DEVELOPMENT.md; link to PRODUCT.md where context is needed. Update the appropriate document when a requirement changes, and remove superseded requirements and their references.
