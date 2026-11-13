---
title: "Choosing an AI model with Slopgrid"
description: "Use Slopgrid to compare four AI models on pricing and privacy questions, inspect their answers and see what they cost."
date: "2026-11-12"
---

Suppose you're choosing a model for a customer-service assistant. You need it to follow your company's pricing and privacy rules, even when a contract has an exception or someone leaves a detail out.

In this walkthrough, we'll use [Slopgrid](/) to give four models the same questions and compare their answers and costs. We'll try Claude Haiku 5.5, Claude Opus 5.5, GPT-6.1 Sol and Grok 4.7.

The broadband company and its policies are invented. The model answers and costs are real.

## Start with a pricing question

In one question, the company's rule caps a $47 price at $50.76, an 8% increase. The proposed plan costs $52 before a discount, but the proposal doesn't say how much that discount is.

Do we have enough information to approve it? **NO**. The plan might qualify, but we don't know the discount amount. In our run, Haiku approved it anyway.

We also ask about sharing customer data, approving an acquisition and pausing a discount after costs rise. The nine questions are our own, inspired by [LegalBench](https://hazyresearch.stanford.edu/legalbench/tasks/) and [ContractNLI](https://stanfordnlp.github.io/contract-nli/).

For several questions, we change one detail and ask again. A discount guaranteed for 12 months keeps one plan under the cap. The same discount guaranteed for only 11 months doesn't count under the company's rule, so that plan goes over the cap. The model's answer should change too.

## Set up the comparison

Open Slopgrid and choose **Chat completion**. Set **Rows** to **Multiple cases** and **Columns** to **Model**. Select the four models, keeping thinking effort at **Model default**.

[![Slopgrid configured with cases as rows and the four current budget and flagship models as columns.](/blog-media/company-values-axes.webp)](/blog-media/company-values-axes.webp)

Use **new variable** to add `$CASE` and `$EXPECTED`. Put each question in its own row. In `$CASE`, include the rules and all the details the model needs. Put the right YES or NO in `$EXPECTED`. You can copy the questions and settings from the [example data](/blog-media/company-values-example.json), which also contains all 36 model answers.

## Write the conversation once

We don't need to write a separate prompt for each model. Give them all this system instruction:

> You review proposed actions for a hypothetical broadband provider. Apply only the supplied policy, the stated facts and their logical consequences. Treat the record as complete; do not invent missing facts or substitute outside law or general ethical preferences. Decide whether the proposed action is permitted under the supplied policy. Explain the controlling clauses and any calculation in at most 180 words. End with a separate line containing exactly YES or NO.

Add a **user** message containing `$CASE`, then an **unfilled** message for the model's response.

[![The shared conversation has a system instruction, the case variable in a user message and an unfilled assistant turn.](/blog-media/company-values-chat.webp)](/blog-media/company-values-chat.webp)

Slopgrid puts each row's `$CASE` into the conversation and sends it to every model. `$EXPECTED` stays with the judge.

## Let the judge check the final answer

Enable **Add a LLM judge** and choose **Gemini 3.8 Flash**. We'll use it to check whether each answer ends with the right YES or NO. Copy the judge prompt from the example data and add this criterion:

> Does the final assistant response's concluding YES or NO match the expected policy decision: $EXPECTED?

Keep **Correct answer** at **YES**. This is the answer we want from the judge. For example, if a model says NO and `$EXPECTED` is NO, the judge should say YES because they match. We still need to read the model's reasoning ourselves.

[![Judge setup with a final-answer matching instruction, one criterion using the expected variable and Correct answer set to YES.](/blog-media/company-values-judge.webp)](/blog-media/company-values-judge.webp)

Connect OpenRouter, set a per-cell generation budget, and choose **Generate**. With nine questions and four models, we'll get 36 answers and 36 judgments. Judge calls cost extra.

## Open the answer that went wrong

Once the run finishes, **Outputs** lets you read the answers side by side. **Judge results** shows which decisions matched, and **Benchmark results** gives you the scores.

![Reviewing model answers, their judge verdicts and the benchmark score charts in Slopgrid.](/blog-media/company-values-review.mp4)

Haiku got eight of the nine decisions right. Opus, Sol and Grok got all nine. The mistake was in the pricing question we started with.

[![The actual score view shows Haiku at eight of nine and Opus, GPT-6.1 Sol and Grok at nine of nine.](/blog-media/company-values-scores.webp)](/blog-media/company-values-scores.webp)

Open **Laurel C**, the pricing question from the opening. Haiku subtracts $3 from the new plan's price and approves it. That $3 belongs to the old plan. The new discount's amount isn't given. Opus, Sol and Grok all catch this and answer NO.

[![Actual responses to Laurel C: Haiku invents a replacement credit and concludes YES; Opus identifies the missing amount and concludes NO.](/blog-media/company-values-comparison.webp)](/blog-media/company-values-comparison.webp)

## Check the bill

| Model | Recorded generation cost |
| --- | ---: |
| Claude Haiku 5.5 | $0.0075 |
| Claude Opus 5.5 | $0.1956 |
| GPT-6.1 Sol | $0.0417 |
| Grok 4.7 | $0.2184 |

Those are the recorded generation costs for nine answers per model, with thinking effort left at **Model default**. Judge charges are separate.

Sol cost the least of the models that got all nine answers right. Haiku cost less than a cent, but its answer approved a price increase using a discount it made up.

Nine questions won't settle your model choice. To try this with your assistant, add questions from your own policies to the grid and run the comparison again.
