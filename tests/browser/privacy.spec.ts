import { expect, test } from "@playwright/test";
import { installIpcMock } from "./ipcMock";

const routes = [
  "/",
  "/today",
  "/calendar",
  "/habits",
  "/mood",
  "/dashboards",
  "/documents",
  "/projects",
  "/issues",
  "/graph",
  "/settings",
];

test("every page works with no request leaving the machine (U2-P6-04)", async ({
  page,
}) => {
  const outside: string[] = [];
  await page.route(/^(?!(http:\/\/127\.0\.0\.1:1420|data:|blob:))/, (route) => {
    outside.push(route.request().url());
    return route.abort();
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installIpcMock(page);
  for (const route of routes) {
    await page.goto(route);
    await expect(page.getByRole("main")).toBeVisible();
    await page.waitForLoadState("networkidle");
  }
  expect(outside).toEqual([]);
  // Canary: the interceptor must see an outside request, or the check above proves nothing.
  await page.evaluate(() =>
    fetch("https://example.com/canary").catch(() => null),
  );
  expect(outside).toEqual(["https://example.com/canary"]);
  expect(errors).toEqual([]);
});
