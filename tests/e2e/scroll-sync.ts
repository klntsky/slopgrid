import { expect, type Locator } from "@playwright/test";

export async function expectItemProgress(
  views: Locator,
  itemSelector: string,
  index: number,
) {
  await expect
    .poll(() =>
      views.evaluateAll(
        (views, { itemSelector, index }) => {
          const items = views.map((view) => {
            const panel = view.getBoundingClientRect();
            const item = view
              .querySelectorAll(itemSelector)
              [index].getBoundingClientRect();
            return {
              progress: (panel.top - item.top) / item.height,
              height: item.height,
              scroll: view.scrollTop,
              limit: view.scrollHeight - view.clientHeight,
            };
          });
          const source = items[0].progress;
          return Math.max(
            0,
            ...items.slice(1).map((item) => {
              if (item.scroll <= 1 && item.progress > source) return 0;
              if (item.scroll >= item.limit - 1 && item.progress < source)
                return 0;
              return Math.abs(item.progress - source) * item.height;
            }),
          );
        },
        { itemSelector, index },
      ),
    )
    .toBeLessThan(1);
}
