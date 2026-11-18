import { expect, test } from "@playwright/test";

// Opt-in timing for the document editor engine (U2-P6-13). It runs the app's
// own Tiptap schema in Chromium without the React page around it, so it
// measures typing cost in the document itself. Wall-clock times vary by
// machine, so it only runs with PERF=1:
//   PERF=1 npx playwright test documentPerformance --reporter=line
test.skip(!process.env.PERF, "timings are opt-in");

for (const words of [1000, 5000, 20000]) {
  test(`typing in a ${words}-word document`, async ({ page }) => {
    await page.goto("/");
    const result = await page.evaluate(async (words) => {
      const load = (p: string) => import(/* @vite-ignore */ p);
      const react = await load("/node_modules/.vite/deps/@tiptap_react.js");
      const schema = await load("/src/features/documents/editor/schema.ts");
      const paragraphs = Array.from(
        { length: Math.ceil(words / 50) },
        (_, i) => ({
          type: "paragraph",
          content: [
            {
              type: "text",
              text: Array.from(
                { length: 50 },
                (_, j) => `word${i * 50 + j}`,
              ).join(" "),
            },
          ],
        }),
      );
      const host = document.createElement("div");
      document.body.append(host);
      const made = performance.now();
      const editor = new react.Editor({
        element: host,
        extensions: schema.documentExtensions,
        content: { type: "doc", content: paragraphs },
      });
      const load_ms = performance.now() - made;
      editor.commands.focus("end");
      const times: number[] = [];
      for (let i = 0; i < 300; i++) {
        const t = performance.now();
        editor.commands.insertContent("a");
        times.push(performance.now() - t);
      }
      times.sort((a, b) => a - b);
      const saved = performance.now();
      JSON.stringify(editor.getJSON());
      const serialize_ms = performance.now() - saved;
      editor.destroy();
      return {
        load_ms,
        median: times[150],
        p95: times[285],
        max: times[299],
        serialize_ms,
      };
    }, words);
    console.log(`DOC words=${words} ${JSON.stringify(result)}`);
    expect(result.median).toBeLessThan(50);
  });
}
