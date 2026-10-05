import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Button, Input, Label, StatusBadge } from "./ui";

describe("ui primitives", () => {
  it("StatusBadge shows the plain short label", () => {
    const html = renderToStaticMarkup(<StatusBadge status="controller_resolution" />);
    expect(html).toContain("Finding who to contact");
    expect(html).not.toContain("controller");
  });

  it("Button has a visible focus style", () => {
    expect(renderToStaticMarkup(<Button>Go</Button>)).toContain("focus-visible:outline-2");
  });

  it("Input keeps the focus outline and a strong ring", () => {
    const html = renderToStaticMarkup(<Input />);
    expect(html).not.toContain("focus:outline-none");
    expect(html).toContain("focus:ring-teal-500/60");
  });

  it("Label is at least 12px", () => {
    const html = renderToStaticMarkup(<Label>Name</Label>);
    expect(html).toContain("text-xs");
    expect(html).not.toContain("text-[11px]");
  });
});
