import { describe, it, expect } from "vitest";
import { sanitizeDiagramSvg, diagramIsSafeInput } from "./security";
describe("Mermaid SVG defense in depth", () => {
  it("removes scripts, handlers, external resources and foreign HTML", () => {
    const output = sanitizeDiagramSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><image href="https://evil.test/a.png"/><foreignObject><div>bad</div></foreignObject><rect onclick="alert(1)" fill="url(https://evil.test/x)"/><use href="https://evil.test/resource"/><style>@import url(https://evil.test/style.css); .node{fill:green}</style><text>safe</text></svg>',
    );
    expect(output).not.toMatch(
      /<script|<image|<foreignObject|onclick=|https:\/\/evil/,
    );
    expect(output).toContain("safe");
  });
  it("does not allow per-diagram init/theme CSS overrides or remote links", () => {
    expect(diagramIsSafeInput("graph TD\n A --> B")).toBe(true);
    expect(
      diagramIsSafeInput('%%{init: {"themeCSS": "x"}}%%\ngraph TD\n A-->B'),
    ).toBe(false);
    expect(diagramIsSafeInput("---\nconfig: {}\n---\ngraph TD")).toBe(false);
    expect(diagramIsSafeInput('graph TD\nclick A "https://evil.test"')).toBe(
      false,
    );
  });
});
