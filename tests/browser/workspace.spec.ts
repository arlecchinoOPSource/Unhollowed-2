import { expect, test } from "@playwright/test";

test("loads Home, navigates every page, and persists appearance offline", async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === "http://127.0.0.1:1420"
      ? route.continue()
      : route.abort(),
  );
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Welcome to Unhollowed." }),
  ).toBeVisible();
  const navigation = page.getByRole("navigation", { name: "Workspace" });
  for (const title of [
    "Documents",
    "Projects",
    "Calendar",
    "Graph",
    "Habits",
    "Mood",
    "Dashboards",
    "Settings",
  ]) {
    const link = navigation.getByRole("link", { name: title, exact: true });
    await link.click();
    await expect(link).toHaveAttribute("aria-current", "page");
    await expect(
      page.getByRole("heading", { name: title, level: 1 }),
    ).toBeVisible();
  }
  const toggle = page.getByRole("button", { name: "Toggle sidebar" });
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(navigation).toBeHidden();
  await page.keyboard.press("Enter");
  await expect(navigation).toBeVisible();
  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Switch to light mode" }).click();
  await navigation.getByRole("link", { name: "Home", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome to Unhollowed." }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(errors).toEqual([]);
});
