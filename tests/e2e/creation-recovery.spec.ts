import { test, expect } from "./fixtures";
import { create, expectProgress } from "./helpers";

test("a lost creation response followed by reload recovers one grid", async ({
  page,
}) => {
  let discarded = false;
  let savedId = "";
  const requests: string[] = [];
  await page.route("**/api/grids", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    requests.push(route.request().postDataJSON().creationRequestId);
    const response = await route.fetch();
    if (!discarded) {
      expect(response.status()).toBe(201);
      savedId = (await response.json()).id;
      discarded = true;
      await route.abort("failed");
    } else await route.fulfill({ response });
  });
  await create(page, "Markdown", "cat", "hat");
  await expect(page.getByRole("alert")).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/grid/${savedId}$`));
  await expectProgress(page, 1, 1);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toBe(requests[0]);
  expect(
    (await (await page.request.get("/api/grids")).json()).grids,
  ).toHaveLength(1);
});
