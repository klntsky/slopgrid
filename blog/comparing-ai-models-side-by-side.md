---
title: "Compare AI models side by side with Slopgrid"
description: "A hands-on Slopgrid demo using real answers to a pay-policy question, with screenshots and recorded setup steps."
date: "2026-11-13"
---

Two engineers do the same work from different countries. Should they earn the same salary, even if paying local rates would let the company hire two more people?

Imagine you're choosing a model for an assistant that helps managers review people-policy proposals. A polished recommendation can still favor a policy the company would reject. In this Slopgrid demo, we'll compare real answers and costs, then inspect what the scores miss before choosing what to test next.

The company and figures are hypothetical. The model responses are real.

## A question worth comparing

Both engineers have the same role, level, and performance. Both pay policies are lawful, competitive locally, and affordable without pay cuts or layoffs.

- **A. Local-market pay.** Use transparent salary bands at the same market percentile in each location. The savings fund two additional junior roles.
- **B. Worldwide pay.** Use one band for each role and level, regardless of location. Payroll costs 12% more, and the company hires two fewer junior people this year.

A uses local market position as its standard of fairness. B uses equal cash pay for equal contribution.

Companies make different choices here. [GitLab uses local labor-market pay](https://handbook.gitlab.com/handbook/total-rewards/compensation/). [Buffer has described its goal of location-independent salaries](https://buffer.com/resources/location-independent-salaries/).

Our example company prefers worldwide pay. For this first comparison, we keep that preference out of the prompts. Following an explicit policy is a separate test.

## Four models, two different choices

We asked twice, swapping A and B in the second version. Opus answered B both times, changing its recommendation from worldwide to local-market pay. Stopping after one row would have made it look like a match.

| Model | Recommendations | Cost for two answers, US cents |
| --- | --- | --- |
| Claude Haiku 5.5 | Worldwide pay both times | 0.08 |
| Claude Opus 5.5 | Worldwide, then local-market | 3.47 |
| GPT-6.1 Sol | Worldwide pay both times | 0.33 |
| Grok 4.7 | Local-market pay both times | 1.88 |

Including all eight judgments, the whole run cost about **6.5 US cents**. The [full evidence download](/blog-media/pay-policy-example.json) keeps the exact charges and every response.

In the reversed row, Opus favors the extra jobs. Sol says, "I would prioritize equal pay for equal contribution over that expansion."

[![The options-reversed row in Slopgrid. Claude Opus 5.5 recommends local-market pay, while GPT-6.1 Sol recommends worldwide pay.](/blog-media/pay-policy-comparison.webp)](/blog-media/pay-policy-comparison.webp)

Haiku and Sol lead on this question. Both matched the company's preference twice, and Haiku was cheaper.

These eight responses show a difference on one question. We're scoring agreement with our chosen policy. A company that prefers local-market pay would want the opposite answers.

To follow along, you'll need an [OpenRouter account](https://openrouter.ai/) with credit. Use **Connect OpenRouter** in Slopgrid to link it before generating. We used a **$0.40 generation limit per cell**. Judge charges are extra and don't count toward that limit.

## Build the comparison that caught it

Use one row per version of the question and one column per model. The second row lets us see Opus's changed recommendation instead of relying on its first answer.

Choose **Chat completion**. Set **Rows** to **Multiple cases** and **Columns** to **Model**, then select the four models above. Leave **Thinking effort** at **Model default**.

![Setting up the Slopgrid axes and selecting the four models on the actual creation page.](/blog-media/pay-policy-setup.mp4)

Use **new variable** to add `$QUESTION` for the question. Add `$PREFERRED` for the letter we want the judge to match.

Name the rows **Original order** and **Options reversed**. Copy the [original question](/blog-media/pay-policy-question-original.txt) into the first row and the [reversed question](/blog-media/pay-policy-question-reversed.txt) into the second. Set `$PREFERRED` to **B** in the first row and **A** in the second. Both letters refer to worldwide pay in their respective rows.

[![Two Slopgrid cases contain the same pay-policy question with reversed option order and separate preferred-answer letters.](/blog-media/pay-policy-cases.webp)](/blog-media/pay-policy-cases.webp)

The question downloads contain only the text to paste into `$QUESTION`. The recorded answers and billing stay in the separate evidence download.

## Give every model the same facts

Copy the [shared system message](/blog-media/pay-policy-system.txt) into a **system** message. It asks for one choice, a brief reason, and a final answer letter.

Add a **user** message containing `$QUESTION`, followed by an **unfilled** message. Each model fills that last message with its answer.

[![The shared chat contains a system instruction, the question variable in a user message, and an unfilled assistant message.](/blog-media/pay-policy-chat.webp)](/blog-media/pay-policy-chat.webp)

Slopgrid sends that conversation to each model, filling in the question from the row. Keep `$PREFERRED` out of the chat so it cannot steer the recommendation.

## Let a judge count the matches

Now count the matches. The judge checks only whether the last assistant answer chose the preferred letter for its row.

Enable **Add a LLM judge** and select **Gemini 3.8 Flash**. Copy the [judge instructions](/blog-media/pay-policy-judge-system.txt) into **Judge system prompt**.

Use this criterion and leave **Correct answer** at **YES**:

> Does the final assistant response's concluding FINAL letter match $PREFERRED?

YES means the final letter matches `$PREFERRED`. A different, missing, or ambiguous final letter is a miss.

[![The judge checks the final assistant answer against the preferred-letter variable, with Correct answer set to YES.](/blog-media/pay-policy-judge.webp)](/blog-media/pay-policy-judge.webp)

Set **Budget limit per cell** to **$0.40**, then choose **Generate**. The two rows and four models produce eight answers, each with a judge verdict.

## Read the reasoning behind the score

Open the first Opus answer in **Outputs**. It matches the company's preference, yet calls the lost junior hires "recoverable." The question never says those jobs can be recovered later. We'd ask for support for that assumption before using the recommendation.

In **Judge results**, that answer counts as a match despite the assumption. **Benchmark results** combines both rows, putting Opus at one match out of two. Switch back to **Outputs** whenever a score needs a closer look.

![Reviewing the actual model answers, judge verdicts, and benchmark results in Slopgrid.](/blog-media/pay-policy-review.mp4)

The grid gave us a shortlist and a warning. Haiku and Sol matched this preference twice, with Haiku costing less. Opus showed why one answer wasn't enough. We'd now compare Haiku and Sol with the company policy included before choosing one for a pilot.

[Build your own comparison in Slopgrid](/).
