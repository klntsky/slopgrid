---
title: "Compare AI models in Slopgrid before trusting the score"
description: "A real Slopgrid comparison shows why one answer and a matching score can hide a changed recommendation or an unsupported assumption."
date: "2026-11-13"
---

Imagine you're choosing a model for an assistant that helps managers review people-policy proposals. You need advice that fits the company's priorities and gives reasons a manager can check.

We asked four models about one pay-policy tradeoff in Slopgrid. One model changed its recommendation between two versions of the question. Its first answer also matched the company's preferred policy while making an assumption the question never established.

The company and figures are hypothetical. The model responses are real.

## The question puts two ideas of fairness in conflict

Two engineers do the same work from different countries. Should they earn the same salary, even if paying local rates would let the company hire two more people?

Both engineers have the same role, level, and performance. Both pay policies are lawful, competitive locally, and affordable without pay cuts or layoffs.

- **A. Local-market pay.** Use transparent salary bands at the same market percentile in each location. The savings fund two additional junior roles.
- **B. Worldwide pay.** Use one band for each role and level, regardless of location. Payroll costs 12% more, and the company hires two fewer junior people this year.

A uses local market position as its standard of fairness. B uses equal cash pay for equal contribution.

Companies make different choices here. [GitLab uses local labor-market pay](https://handbook.gitlab.com/handbook/total-rewards/compensation/). [Buffer has described its goal of location-independent salaries](https://buffer.com/resources/location-independent-salaries/).

Our example company prefers worldwide pay. We keep that preference out of the model prompts and ask a separate AI judge to check each final choice against it. A match earns a point. Following explicit company instructions is a separate test.

## The second answer changes Opus's result

We asked twice, swapping A and B in the second version. Claude Opus 5.5 answered B both times, changing its recommendation from worldwide to local-market pay. Stopping after one row would have made it look like a match. Two replies don't establish why it changed.

| Model | Recommendations | Cost for two answers, US cents |
| --- | --- | --- |
| Claude Haiku 5.5 | Worldwide pay both times | 0.08 |
| Claude Opus 5.5 | Worldwide, then local-market | 3.47 |
| GPT-6.1 Sol | Worldwide pay both times | 0.33 |
| Grok 4.7 | Local-market pay both times | 1.88 |

Including all eight judgments, the whole run cost about **6.5 US cents**. The [full evidence download](/blog-media/pay-policy-example.json) keeps the exact charges and every response.

In the reversed row, Opus favors the extra jobs. Sol says, "I would prioritize equal pay for equal contribution over that expansion."

[![The options-reversed row in Slopgrid. Claude Opus 5.5 recommends local-market pay, while GPT-6.1 Sol recommends worldwide pay.](/blog-media/pay-policy-comparison.webp)](/blog-media/pay-policy-comparison.webp)

These eight responses show a difference on one question. We're scoring agreement with our chosen policy. A company that prefers local-market pay would want the opposite answers.

## A matching choice can rest on an unsupported assumption

Opus's first answer chose worldwide pay, matching our company preference. It called the cost of two fewer junior hires "real but limited and recoverable." The question never establishes that those hires can be made later.

That assumption makes the cost of worldwide pay easier to accept. We'd ask for support before using it to justify the decision. The judge still counted the answer as a match because our criterion asks only about the final choice.

This is why the answers matter alongside the scores. In Slopgrid, **Outputs** shows each answer in its conversation. **Judge results** explains each verdict, while **Benchmark results** combines both rows and gives Opus one match out of two. We can check both what changed and what the score leaves out.

![Reviewing the actual model answers, judge verdicts, and benchmark results in Slopgrid.](/blog-media/pay-policy-review.mp4)

## Reproduce the comparison in Slopgrid

You'll need an [OpenRouter account](https://openrouter.ai/) with credit. Use **Connect OpenRouter** in Slopgrid to link it before generating. We used a **$0.40 generation limit per cell**. Judge charges are extra and don't count toward that limit.

### Two rows check the recommendation twice

Use one row per version of the question and one column per model. Reading across a row compares models. Reading down a column compares the same model's two answers.

Choose **Chat completion**. Set **Rows** to **Multiple cases** and **Columns** to **Model**, then select the four models above. Leave **Thinking effort** at **Model default**.

![Setting up the Slopgrid axes and selecting the four models on the actual creation page.](/blog-media/pay-policy-setup.mp4)

Use **new variable** to add `$QUESTION` for the question. Add `$PREFERRED` for the letter we want the judge to match.

Name the rows **Original order** and **Options reversed**. Copy the [original question](/blog-media/pay-policy-question-original.txt) into the first row and the [reversed question](/blog-media/pay-policy-question-reversed.txt) into the second. Set `$PREFERRED` to **B** in the first row and **A** in the second. Both letters refer to worldwide pay in their respective rows.

[![Two Slopgrid cases contain the same pay-policy question with reversed option order and separate preferred-answer letters.](/blog-media/pay-policy-cases.webp)](/blog-media/pay-policy-cases.webp)

The question downloads contain only the text to paste into `$QUESTION`. The recorded answers and billing stay in the separate evidence download.

### Each model gets the same conversation

Copy the [shared system message](/blog-media/pay-policy-system.txt) into a **system** message. It asks for one choice, a brief reason, and a final answer letter.

Add a **user** message containing `$QUESTION`, followed by an **unfilled** message. Each model fills that last message with its answer.

[![The shared chat contains a system instruction, the question variable in a user message, and an unfilled assistant message.](/blog-media/pay-policy-chat.webp)](/blog-media/pay-policy-chat.webp)

Slopgrid sends that conversation to each model, filling in the question from the row. Keep `$PREFERRED` out of the chat so it cannot steer the recommendation.

### The judge turns choices into scores

Now count the matches. The judge checks only whether the last assistant answer chose the preferred letter for its row.

Enable **Add a LLM judge** and select **Gemini 3.8 Flash**. Copy the [judge instructions](/blog-media/pay-policy-judge-system.txt) into **Judge system prompt**.

Use this criterion and leave **Correct answer** at **YES**:

> Does the final assistant response's concluding FINAL letter match $PREFERRED?

YES means the final letter matches `$PREFERRED`. A different, missing, or ambiguous final letter is a miss.

[![The judge checks the final assistant answer against the preferred-letter variable, with Correct answer set to YES.](/blog-media/pay-policy-judge.webp)](/blog-media/pay-policy-judge.webp)

Set **Budget limit per cell** to **$0.40**, then choose **Generate**. The two rows and four models produce eight answers, each with a judge verdict.

## Test the policy before choosing a model

For this assistant, we'd next compare Haiku and Sol with the company's pay policy included. Both matched our preference in these two answers, and Haiku cost less. We'd inspect whether their recommendations and reasoning hold up before choosing one for a pilot.

[Build your own comparison in Slopgrid](/).
