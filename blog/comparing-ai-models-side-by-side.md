---
title: "Compare AI models side by side with Slopgrid"
description: "A hands-on Slopgrid demo using real answers to a pay-policy question, with screenshots and recorded setup steps."
date: "2026-11-13"
---

Two engineers do the same work from different countries. Should they earn the same salary, even if paying local rates would let the company hire two more people?

In this Slopgrid demo, you're comparing models for an internal assistant. You'll compare their recommendations under the same prompt, before adding company-specific instructions, then inspect how those answers fit a hypothetical company's priorities.

The company and figures are hypothetical. The model responses are real.

## A question worth comparing

Both engineers have the same role, level, and performance. Both pay policies are lawful, competitive locally, and affordable without pay cuts or layoffs.

- **A. Local-market pay.** Use transparent salary bands at the same market percentile in each location. The savings fund two additional junior roles.
- **B. Worldwide pay.** Use one band for each role and level, regardless of location. Payroll costs 12% more, and the company hires two fewer junior people this year.

A treats fairness as the same standing in each local market; B treats it as equal cash pay for the same contribution.

Companies make different choices here. [GitLab uses local labor-market pay](https://handbook.gitlab.com/handbook/total-rewards/compensation/). [Buffer has described its goal of location-independent salaries](https://buffer.com/resources/location-independent-salaries/).

Our example company prefers B, equal pay for equal contribution. We keep that preference out of the model's conversation. We want its recommendation before adding company-specific instructions.

## Four models, two different priorities

Each model got the same question and instructions. We then reversed A and B and asked again. Every model kept its policy choice.

| Model | Policy chosen in both presentations | Cost for both answers |
| --- | --- | --- |
| Claude Haiku 5.5 | Worldwide pay | $0.00074 |
| Claude Opus 5.5 | Local-market pay | $0.03441 |
| GPT-6.1 Sol | Worldwide pay | $0.00309 |
| Grok 4.7 | Local-market pay | $0.04045 |

Costs are in USD and exclude the judge. The full run, including all eight judgments, cost $0.0855.

Opus and Grok put more weight on the two extra jobs. Sol and Haiku put more weight on paying equally for the same contribution. Both sides recognize the cost.

[![Actual Slopgrid answers from Claude Opus 5.5 and GPT-6.1 Sol. Opus recommends local-market pay; Sol recommends worldwide pay.](/blog-media/pay-policy-comparison.webp)](/blog-media/pay-policy-comparison.webp)

Haiku is the cheapest candidate here, and it agrees with Sol. We'd include it in a larger evaluation before choosing a model.

This comparison measures agreement with a chosen policy. A company that prefers local-market pay would favor the opposite recommendations. The result is limited to this question and these settings.

## Put the question into a grid

One row gives us an answer from every model. Reading across it lets us compare what each model recommends and why.

Choose **Chat completion**. Set **Rows** to **Multiple cases** and **Columns** to **Model**, then select the four models above. Leave **Thinking effort** at **Model default**.

![Setting up the Slopgrid axes and selecting the four models on the actual creation page.](/blog-media/pay-policy-setup.mp4)

Use **new variable** to add `$QUESTION` and `$PREFERRED`. The first holds the question. The second holds the letter our company wants the judge to check.

Give the first row the original question and preferred answer **B**. In the second row, swap the two options and use preferred answer **A**. Name the rows so you can tell them apart.

[![Two Slopgrid cases contain the same pay-policy question with reversed option order and separate preferred-answer letters.](/blog-media/pay-policy-cases.webp)](/blog-media/pay-policy-cases.webp)

The [complete example data](/blog-media/pay-policy-example.json) includes the questions, the exact shared system prompt, judge settings, and recorded responses. Use it to copy the prompts without retyping them.

## Ask once, send it to every model

Write a shared **system** message asking the model to choose one listed option, explain the tradeoff, and finish with `FINAL: A` or `FINAL: B`.

Add a **user** message containing `$QUESTION`, followed by an **unfilled** message. Each model fills that last message with its answer.

[![The shared chat contains a system instruction, the question variable in a user message, and an unfilled assistant message.](/blog-media/pay-policy-chat.webp)](/blog-media/pay-policy-chat.webp)

Slopgrid puts each row's question into the conversation and sends it to every selected model. `$PREFERRED` stays out of that conversation. Only the judge uses it.

## Let a judge count the matches

The check is a letter comparison. It gives us a small example of Slopgrid's judge and score views.

Enable **Add a LLM judge** and select **Gemini 3.8 Flash**. Ask it to check only the last assistant response, extract the concluding `FINAL` letter, and compare it with the preferred letter. It returns true for a match and false otherwise.

Use this criterion:

> Does the final assistant response's concluding FINAL letter match $PREFERRED?

Leave **Correct answer** at **YES**. Here, YES means the judge found a match. The model itself still answers A or B.

[![The judge checks the final assistant answer against the preferred-letter variable, with Correct answer set to YES.](/blog-media/pay-policy-judge.webp)](/blog-media/pay-policy-judge.webp)

Connect OpenRouter, set **Budget limit per cell**, and choose **Generate**. We allowed **$0.40** per cell. Two rows across four models produce eight answers. The judge evaluates each one, and its charges are separate from that limit.

## Read the reasoning behind the score

Start in **Outputs**. Open an answer and read the argument before treating the judge's result as a verdict on the model. Our judge checks the final choice, not the quality of the reasoning.

Switch to **Judge results** to inspect each match, then **Benchmark results** to compare scores. The same grid keeps the answers and judgments together.

![Reviewing the actual model answers, judge verdicts, and benchmark results in Slopgrid.](/blog-media/pay-policy-review.mp4)

Next, add decisions from the work your assistant will do, then try the cases with your company's instructions. A model that agrees with you here may disagree when the tradeoff changes.

[Build your own comparison in Slopgrid](/).
