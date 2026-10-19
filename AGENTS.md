# Repository instructions

1. Use only ASCII characters in documentation unless the user explicitly requests non-ASCII characters in those documents. Before finishing, check modified Markdown documentation for non-ASCII characters and replace them with ASCII equivalents while preserving meaning.

2. Run only tests covering features actually changed, and skip tests for simple changes such as wording, styling, and documentation. Run manual tests only on staging through SSH unless the user explicitly requests local validation. Keep GitHub CI disabled while preserving its workflow file. Before production deployment, run the complete unit, mock browser, and real-provider browser suites on staging unless the user explicitly requests local validation before direct production deployment.

3. Keep README.md focused on a brief product introduction, a grid screenshot immediately after the first paragraph, useful features, and supported grid dimensions grouped by output type, without usage instructions.

4. When the user supplies literal text for documentation inclusion and asks to fill gaps, preserve the supplied text exactly and fill only the gaps.

5. Always commit and push together in one shell command using `git commit ... && git push`.

6. When the agent starts a background task, run its top-level command in tmux session `bg` so the user can inspect it. Application code, test runners, and CI manage their own child processes without requiring tmux.

7. Use the LLM patch tools for text edits, and never use Python for string replacement.

8. Keep ARCHITECTURE.md focused on architectural responsibilities and boundaries; leave granular styling details such as individual breakpoints in the code. Organize it with descriptive headings, short paragraphs, and bullet points grouped by responsibility instead of dense implementation inventories.

9. remember to never editorialize anything I say anywhere - not in the docs, not in the UI, not in your responses when citing

10. Before deploying the PWA changes, present all proposed written descriptions and new visible text to the user and obtain approval.

11. Keep deployment implementation in the private slopgrid-ops repository and use its single deploy.sh command for staging or explicitly requested production deployments. The command owns building, validation, mode selection, promotion, and final status for any committed revision. When the user explicitly requests direct production deployment after local validation, run the complete suites locally and use `production --skip-staging --skip-tests` after they pass. Do not create per-task deployment scripts, patch installed deployment code, or manually fabricate status files. Keep host configuration outside repositories and update the pipeline when infrastructure changes.

12. Keep current product requirements, including UI behavior and visible text, in PRODUCT.md. Keep architectural responsibilities and system boundaries in ARCHITECTURE.md. Implementation details belong in the code and do not need documentation; remove them from product requirements without moving them to another document. Keep development setup, tooling, test design, and validation guidance in DEVELOPMENT.md. Keep agent instructions and workflow rules in AGENTS.md, and keep README.md within the introduction scope defined above. Do not duplicate product requirements in ARCHITECTURE.md or DEVELOPMENT.md; link to PRODUCT.md where context is needed. Test guidance may explain how a requirement is validated without defining product behavior. Update the appropriate document when a requirement changes, and remove superseded requirements and their references.
