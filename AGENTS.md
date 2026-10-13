# Repository instructions

1. Use only ASCII characters in documentation unless the user explicitly requests non-ASCII characters in those documents. Before finishing, check modified Markdown documentation for non-ASCII characters and replace them with ASCII equivalents while preserving meaning.

2. Run only tests covering features actually changed, and skip tests for simple changes such as wording, styling, and documentation. Run tests only on staging through SSH. Before production deployment, run the complete unit, mock browser, and real-provider browser suites on staging.

3. Keep README.md focused on a brief product introduction, a grid screenshot immediately after the first paragraph, useful features, and supported grid dimensions grouped by output type, without usage instructions.

4. When the user supplies literal text for documentation inclusion and asks to fill gaps, preserve the supplied text exactly and fill only the gaps.
