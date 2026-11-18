import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { installIpcMock } from "./ipcMock";

// The open document editor with every toolbar panel expanded, scanned for
// WCAG 2.2 AA problems in both themes (U2-P6-14). The route list in
// accessibility.spec.ts only reaches the document library.
const tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

for (const scheme of ["light", "dark"] as const) {
  test(`the document editor and its panels pass automated checks in ${scheme} mode`, async ({
    page,
  }) => {
    await page.emulateMedia({
      colorScheme: scheme,
      reducedMotion: "reduce",
    });
    await page.addInitScript(() =>
      Object.assign(window, { __seedDocuments: ["Essay", "Notes"] }),
    );
    await installIpcMock(page);
    await page.goto("/documents?doc=doc-1");
    const editor = page.getByRole("textbox", { name: "Document content" });
    await expect(editor).toBeVisible();
    for (const panel of await page.locator("details > summary").all()) {
      await panel.click();
    }
    const results = await new AxeBuilder({ page }).withTags(tags).analyze();
    expect(
      results.violations.map(
        (violation) =>
          `${violation.id}: ${violation.nodes.map((node) => node.html.slice(0, 160)).join(" | ")}`,
      ),
    ).toEqual([]);
  });
}

test("the document editor is usable by keyboard and has no sideways scroll at 620 px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 620, height: 700 });
  await page.addInitScript(() =>
    Object.assign(window, { __seedDocuments: ["Essay"] }),
  );
  await installIpcMock(page);
  await page.goto("/documents?doc=doc-1");
  const editor = page.getByRole("textbox", { name: "Document content" });
  await expect(editor).toBeVisible();
  // Tab from the editor reaches a control that shows focus.
  await editor.focus();
  await page.keyboard.press("Shift+Tab");
  const focused = await page.evaluate(() => {
    const element = document.activeElement as HTMLElement;
    const style = getComputedStyle(element);
    return {
      tag: element.tagName,
      outline: parseFloat(style.outlineWidth),
      shadow: style.boxShadow !== "none",
    };
  });
  expect(focused.outline >= 2 || focused.shadow).toBe(true);
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
