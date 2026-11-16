import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { labelColors } from "../../src/database/labels";

// WCAG 2.2 relative luminance and contrast ratio.
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const channel = parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

// Read the theme tokens so the test follows any change to them.
function tokens(css: string, selector: string): Record<string, string> {
  const block = css.slice(css.indexOf(selector));
  const body = block.slice(block.indexOf("{") + 1, block.indexOf("}"));
  return Object.fromEntries(
    [...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((match) => [
      match[1],
      match[2],
    ]),
  );
}

const css = readFileSync("src/styles/workspace.css", "utf8");
const light = tokens(css, ":root {");
const dark = { ...light, ...tokens(css, ':root[data-theme="dark"]') };

test.each(Object.entries(labelColors))(
  "%s label swatches meet 3:1 non-text contrast in both themes",
  (_, color) => {
    for (const surface of [light.surface, light.background]) {
      expect(contrast(color.light, surface)).toBeGreaterThanOrEqual(3);
    }
    for (const surface of [dark.surface, dark.background]) {
      expect(contrast(color.dark, surface)).toBeGreaterThanOrEqual(3);
    }
  },
);
