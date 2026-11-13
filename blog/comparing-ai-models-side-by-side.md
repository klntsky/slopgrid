---
title: "Choosing an AI model with Slopgrid"
description: "Compare budget and flagship AI models on contract-style policy cases, inspect their reasoning and weigh accuracy against cost in Slopgrid."
date: "2026-11-12"
---

Can a budget model apply your company's rules as reliably as a flagship? We'll use [Slopgrid](/) to compare their answers to the same questions, inspect the mistakes, and decide what is worth paying for.

Our example is a hypothetical broadband provider that turns its privacy and affordability values into written rules. The company, policies and records are invented. The model responses are real.

We'll compare current Claude Haiku 5.5 with Claude Opus 5.5, GPT-6.1 Sol and Grok 4.7.

## Choose cases that can catch a mistake

Asking whether privacy matters won't tell us much. We need questions where an assistant can sound convincing while missing a condition.

We wrote nine original cases using the rule-and-fact approach found in [LegalBench](https://hazyresearch.stanford.edu/legalbench/tasks/) and [ContractNLI](https://stanfordnlp.github.io/contract-nli/):

- Six overlapping customer reports each clear the minimum group size. Changing one count determines whether their combination exposes individual activity flags.
- An acquisition looks approved after a notice period, but consent depends on two competing chains of board-appointment rights.
- Two records show the same headline cost increase. Exclusions, reimbursements and a narrowly worded exception change which costs count.
- A price cap depends on mandatory fees, tax exclusions and a discount's guarantee. One record leaves out the discount amount entirely.

Eight cases form matched pairs. The ninth checks whether the record establishes permission when a necessary fact is missing. Each expected decision has a written proof from the supplied rules. The candidates receive those rules and facts, but never the answer key.

Take the pricing control. The old covered bill is $47; an 8% cap allows $50.76. Replacement charges total $52 before a guaranteed credit, but the record never gives the credit amount. Does that record establish that the plan can be approved? **NO**: it might qualify, but the missing amount prevents us from establishing permission.

Open Slopgrid and choose **Chat completion**. Set **Rows** to **Multiple cases** and **Columns** to **Model**. Select **Claude Haiku 5.5**, **Claude Opus 5.5**, **GPT-6.1 Sol** and **Grok 4.7**, keeping thinking effort at **Model default**.

[![Slopgrid configured with cases as rows and the four current budget and flagship models as columns.](/blog-media/company-values-axes.webp)](/blog-media/company-values-axes.webp)

Use **new variable** to add `$CASE` and `$EXPECTED`. Each `$CASE` contains a policy, its factual record and a question. `$EXPECTED` holds the final YES or NO derived from that policy. The [complete example data](/blog-media/company-values-example.json) includes all cases, answer proofs, settings and 36 recorded responses.

## Write the conversation once

Give every candidate the same system instruction:

> You review proposed actions for a hypothetical broadband provider. Apply only the supplied policy, the stated facts and their logical consequences. Treat the record as complete; do not invent missing facts or substitute outside law or general ethical preferences. Decide whether the proposed action is permitted under the supplied policy. Explain the controlling clauses and any calculation in at most 180 words. End with a separate line containing exactly YES or NO.

Add a **user** message containing `$CASE`, then an **unfilled** message for the model's response.

[![The shared conversation has a system instruction, the case variable in a user message and an unfilled assistant turn.](/blog-media/company-values-chat.webp)](/blog-media/company-values-chat.webp)

Slopgrid inserts each row's policy and record, then sends the conversation to every selected model. We're testing whether the models apply the rules, not whether they guess our preferences.

## Let the judge check the final answer

Enable **Add a LLM judge** and choose **Gemini 3.8 Flash**. Its job is small: read the final assistant answer and compare its concluding YES or NO with the key. Use the judge prompt from the example data and one criterion:

> Does the final assistant response's concluding YES or NO match the expected policy decision: $EXPECTED?

Keep **Correct answer** at **YES**, meaning that the decision matches. The judge checks the final decision, not the validity of every sentence in the explanation.

[![Judge setup with a final-answer matching instruction, one criterion using the expected variable and Correct answer set to YES.](/blog-media/company-values-judge.webp)](/blog-media/company-values-judge.webp)

Connect OpenRouter, set a per-cell generation budget, and choose **Generate**. Judge calls are charged separately. Nine cases across four models produce 36 answers and judgments.

## Compare accuracy, then cost

Switch between **Outputs**, **Judge results** and **Benchmark results**. You can read the advice, inspect why it passed or failed, and compare each model's score without juggling separate chats.

![Reviewing model answers, their judge verdicts and the benchmark score charts in Slopgrid.](/blog-media/company-values-review.mp4)

Haiku matched eight of the nine expected decisions. The three flagships matched all nine. That is enough to investigate the missed case, not enough to declare any model a dependable legal adviser.

[![The actual score view shows Haiku at eight of nine and Opus, GPT-6.1 Sol and Grok at nine of nine.](/blog-media/company-values-scores.webp)](/blog-media/company-values-scores.webp)

Open **Laurel C**, the pricing record with no replacement-credit amount. Haiku deducts $3 anyway and approves the plan. The record gives that figure for the previous plan, not the replacement. The flagships instead identify the missing amount and decline to say that approval is established.

[![Actual responses to Laurel C: Haiku invents a replacement credit and concludes YES; Opus identifies the missing amount and concludes NO.](/blog-media/company-values-comparison.webp)](/blog-media/company-values-comparison.webp)

Now compare what the saved answers cost:

| Model | Recorded generation cost |
| --- | ---: |
| Claude Haiku 5.5 | $0.0075 |
| Claude Opus 5.5 | $0.1956 |
| GPT-6.1 Sol | $0.0417 |
| Grok 4.7 | $0.2184 |

These are totals for the nine saved cells per model, excluding judge charges.

For this run, Sol is the economical candidate among the models that passed every check. Haiku is cheaper, but its invented discount would turn an incomplete record into an approval. The price difference is useful only after you've looked at the mistake.

That is the workflow to take back to your own assistant: supply the rules, include close variants and missing facts, then inspect both the score and the reasoning before choosing a model. These original cases demonstrate the comparison; their scores are not official legal-benchmark results or a production sign-off.
