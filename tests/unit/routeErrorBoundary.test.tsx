import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test, vi } from "vitest";
import { RouteErrorBoundary } from "../../src/components/layout/RouteErrorBoundary";

afterEach(cleanup);

let explode = true;
function Page() {
  if (explode) throw new Error("secret workspace text");
  return <p>Page works</p>;
}

test("a page that throws shows fixed, private text and can recover (U2-P6-15)", () => {
  // React reports the caught error to the console; keep the test output clean.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  explode = true;
  const { rerender } = render(
    <MemoryRouter>
      <RouteErrorBoundary resetKey="/a">
        <Page />
      </RouteErrorBoundary>
    </MemoryRouter>,
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Something went wrong on this page",
  );
  expect(document.body).not.toHaveTextContent("secret workspace text");
  expect(screen.getByRole("link", { name: "Go to Home" })).toHaveAttribute(
    "href",
    "/",
  );

  // Try again re-renders the page.
  explode = false;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(screen.getByText("Page works")).toBeInTheDocument();

  // A failure on one route does not stick to the next route.
  explode = true;
  rerender(
    <MemoryRouter>
      <RouteErrorBoundary resetKey="/a">
        <Page />
      </RouteErrorBoundary>
    </MemoryRouter>,
  );
  expect(screen.getByRole("alert")).toBeInTheDocument();
  explode = false;
  rerender(
    <MemoryRouter>
      <RouteErrorBoundary resetKey="/b">
        <Page />
      </RouteErrorBoundary>
    </MemoryRouter>,
  );
  expect(screen.getByText("Page works")).toBeInTheDocument();
});
