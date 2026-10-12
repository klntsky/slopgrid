# Repository instructions

1. Use only ASCII characters in documentation unless the user explicitly requests non-ASCII characters in those documents. Before finishing, check modified Markdown documentation for non-ASCII characters and replace them with ASCII equivalents while preserving meaning.

2. Run only tests covering features actually changed, and skip tests for simple changes such as wording, styling, and documentation. Run tests only on staging through SSH. Before production deployment, run the complete unit, mock browser, and real-provider browser suites on staging.
