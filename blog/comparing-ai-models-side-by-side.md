---
title: "Compare AI models side by side with Slopgrid"
description: "A hands-on Slopgrid demo using real answers to a pay-policy question, with screenshots and recorded setup steps."
date: "2026-11-13"
---

Two engineers do the same work from different countries. Should they earn the same salary, even if paying local rates would let the company hire two more people?

Imagine you're choosing a model for an internal assistant. You want to see what it recommends before giving it a company policy to follow. In this Slopgrid demo, we'll compare four models' answers and costs, then build the grid so you can run your own comparison.

The company and figures are hypothetical. The model responses are real.

## A question worth comparing

Both engineers have the same role, level, and performance. Both pay policies are lawful, competitive locally, and affordable without pay cuts or layoffs.

- **A. Local-market pay.** Use transparent salary bands at the same market percentile in each location. The savings fund two additional junior roles.
- **B. Worldwide pay.** Use one band for each role and level, regardless of location. Payroll costs 12% more, and the company hires two fewer junior people this year.

A uses local market position as its standard of fairness. B uses equal cash pay for equal contribution.

Companies make different choices here. [GitLab uses local labor-market pay](https://handbook.gitlab.com/handbook/total-rewards/compensation/). [Buffer has described its goal of location-independent salaries](https://buffer.com/resources/location-independent-salaries/).

For this demo, the company prefers B. We keep that preference out of the models' prompts and use it only to judge their answers.

## Four models, two different choices

We asked the question twice, swapping A and B in the second version. Opus answered B both times. That meant worldwide pay first and local-market pay second.

| Model | Recommendations | Cost for both answers |
| --- | --- | --- |
| Claude Haiku 5.5 | Worldwide pay both times | $0.00075 |
| Claude Opus 5.5 | Worldwide, then local-market | $0.03471 |
| GPT-6.1 Sol | Worldwide pay both times | $0.00334 |
| Grok 4.7 | Local-market pay both times | $0.01885 |

The table shows generation costs in USD. Including the AI judge, the whole run cost $0.0650.

In the reversed row, Opus favors the extra jobs. Sol says, "I would prioritize equal pay for equal contribution over that expansion."

[![The options-reversed row in Slopgrid. Claude Opus 5.5 recommends local-market pay, while GPT-6.1 Sol recommends worldwide pay.](/blog-media/pay-policy-comparison.webp)](/blog-media/pay-policy-comparison.webp)

Haiku agreed with Sol and cost the least. We'd keep it in the next round of testing.

These eight responses show a difference on one question. We're scoring agreement with our chosen policy. A company that prefers local-market pay would want the opposite answers.

## Put the question into a grid

Put questions in rows and models in columns. Reading across a row lets you compare answers to the same question.

Choose **Chat completion**. Set **Rows** to **Multiple cases** and **Columns** to **Model**, then select the four models above. Leave **Thinking effort** at **Model default**.

![Setting up the Slopgrid axes and selecting the four models on the actual creation page.](/blog-media/pay-policy-setup.mp4)

Use **new variable** to add `$QUESTION` for the question. Add `$PREFERRED` for the letter we want the judge to match.

Name the rows **Original order** and **Options reversed**. Put the question in both rows, swapping A and B in the second. Set `$PREFERRED` to **B** in the first row and **A** in the second.

[![Two Slopgrid cases contain the same pay-policy question with reversed option order and separate preferred-answer letters.](/blog-media/pay-policy-cases.webp)](/blog-media/pay-policy-cases.webp)

Copy both questions from the [complete example data](/blog-media/pay-policy-example.json). It also includes the shared prompt, judge settings, and recorded answers.

## Write the conversation once

Write a shared **system** message asking the model to choose one listed option, explain the tradeoff, and finish with `FINAL: A` or `FINAL: B`.

Add a **user** message containing `$QUESTION`, followed by an **unfilled** message. Each model fills that last message with its answer.

[![The shared chat contains a system instruction, the question variable in a user message, and an unfilled assistant message.](/blog-media/pay-policy-chat.webp)](/blog-media/pay-policy-chat.webp)

Slopgrid inserts each row's question into the chat and sends it to every model. `$PREFERRED` appears only in the judge's instructions.

## Let a judge count the matches

We'll use this letter check to try Slopgrid's judging workflow. Its verdicts let us count how often each model agrees with the company.

Enable **Add a LLM judge** and select **Gemini 3.8 Flash**. Tell it to read only the last assistant response and compare its concluding `FINAL` letter with `$PREFERRED`. A match returns true. Everything else returns false.

Use this criterion:

> Does the final assistant response's concluding FINAL letter match $PREFERRED?

Leave **Correct answer** at **YES**. Here, YES means the judge found a match. The model itself still answers A or B.

[![The judge checks the final assistant answer against the preferred-letter variable, with Correct answer set to YES.](/blog-media/pay-policy-judge.webp)](/blog-media/pay-policy-judge.webp)

Connect OpenRouter, set **Budget limit per cell**, and choose **Generate**. We allowed **$0.40** per cell. Two rows across four models produce eight answers. The judge evaluates each one, and its charges are separate from that limit.

## Read the reasoning behind the score

Start in **Outputs** and open an answer. Read the argument before trusting the score. Our judge checks the chosen letter, so a match can still come with weak reasoning.

Switch to **Judge results** to inspect each verdict. **Benchmark results** shows the scores by model, with the original answers still available in **Outputs**.

![Reviewing the actual model answers, judge verdicts, and benchmark results in Slopgrid.](/blog-media/pay-policy-review.mp4)

One pay question gives us a starting point. Add decisions your assistant will face at work, then repeat the comparison with your company's instructions.

[Build your own comparison in Slopgrid](/).
