import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Markdown } from "./Markdown";
import mermaid from "mermaid";
const props = { onSource: vi.fn(), onPage: vi.fn() };
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>diagram</text></svg>',
    })),
  },
}));
describe("safe Markdown renderer", () => {
  it('only marks a genuine duplicate document title, never hides a different human heading',()=>{const {rerender}=render(<Markdown {...props} leadingTitle="Overview" value={'# Overview\n\n## Detail'}/>);expect(screen.queryByRole('heading',{name:'Overview'})).toBeNull();expect(screen.getByText('Overview')).toHaveAttribute('aria-hidden','true');rerender(<Markdown {...props} leadingTitle="Overview" value={'# Human decision\n\n## Detail'}/>);expect(screen.getByRole('heading',{name:'Human decision'})).toHaveAttribute('data-title-duplicate','false');});
  it("renders raw HTML as inert/omitted content, never scripts or event handlers", () => {
    const { container } = render(
      <Markdown
        {...props}
        value={
          '# Safe title\n\n<script>window.pwned=1</script>\n\n<img src=x onerror="window.pwned=1">\n\nordinary text'
        }
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Safe title" }),
    ).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("[onerror]")).toBeNull();
    expect((window as any).pwned).toBeUndefined();
  });
  it("does not activate dangerous URL schemes or external image tracking", () => {
    const { container } = render(
      <Markdown
        {...props}
        value={
          "[bad](javascript:alert%281%29)\n\n![pixel](https://track.invalid/pixel.png)"
        }
      />,
    );
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(/图片/)).toBeInTheDocument();
  });
  it("opens exact validated source path and line span via callback", () => {
    const onSource = vi.fn();
    render(
      <Markdown
        {...props}
        onSource={onSource}
        value={"[service.py](source:app/service.py#L12-L20)"}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /service.py/ }));
    expect(onSource).toHaveBeenCalledWith({
      path: "app/service.py",
      start_line: 12,
      end_line: 20,
    });
  });
  it("routes Wiki page links internally", () => {
    const onPage = vi.fn();
    render(
      <Markdown {...props} onPage={onPage} value={"[模块](modules/core.md)"} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "模块" }));
    expect(onPage).toHaveBeenCalledWith("modules/core");
  });
  it("makes external web links noopener noreferrer", () => {
    render(<Markdown {...props} value={"[Docs](https://example.com/docs)"} />);
    expect(screen.getByRole("link", { name: "Docs" })).toHaveAttribute(
      "rel",
      "noopener noreferrer",
    );
    expect(screen.getByRole("link", { name: "Docs" })).toHaveAttribute(
      "target",
      "_blank",
    );
  });
  it("keeps same-document links inside the embedded panel instead of changing host hash", () => {
    window.history.replaceState(null, "", "/#host-chat");
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    render(<Markdown {...props} value={"[Details](#details)\n\n## Details"} />);
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(scroll).toHaveBeenCalled();
    expect(window.location.hash).toBe("#host-chat");
  });
  it("keeps external GitHub line citations external, including uppercase HTTPS", () => {
    const source = vi.fn();
    render(
      <Markdown
        {...props}
        onSource={source}
        value={
          "[GitHub](https://github.com/a/b/blob/main/a.ts#L10-L20)\n\n[Other](HTTPS://example.com/docs)"
        }
      />,
    );
    expect(screen.getByRole("link", { name: "GitHub" })).toHaveAttribute(
      "target",
      "_blank",
    );
    expect(screen.getByRole("link", { name: "Other" })).toHaveAttribute(
      "target",
      "_blank",
    );
    expect(source).not.toHaveBeenCalled();
  });
  it("does not turn blocked or empty links into host-navigation reloads", () => {
    const { container } = render(
      <Markdown
        {...props}
        value={"[Blocked](javascript:alert%281%29) [Empty]()"}
      />,
    );
    expect(container.querySelector("a")).toBeNull();
    expect(screen.getByText("Blocked")).toBeInTheDocument();
  });
  it("retains diagram controls during live project-status rerenders", async () => {
    const value = "```mermaid\ngraph LR\nA-->B\n```";
    const { rerender } = render(<Markdown {...props} value={value} />);
    await screen.findByText("diagram");
    expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({htmlLabels:false, securityLevel:'strict'}));
    fireEvent.click(screen.getByRole("button", { name: "放大图表" }));
    expect(
      screen.getByRole("button", { name: "重置图表缩放" }),
    ).toHaveTextContent("125%");
    rerender(<Markdown value={value} onSource={() => {}} onPage={() => {}} />);
    expect(
      screen.getByRole("button", { name: "重置图表缩放" }),
    ).toHaveTextContent("125%");
  });
  it("fits diagrams to their viewport and exposes original size without clipping controls", async () => {
    const { container } = render(<Markdown {...props} value={"```mermaid\ngraph LR\nA-->B\n```"} />);
    await screen.findByText("diagram");
    expect(screen.getByRole("button", {name: "适应图表宽度"})).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", {name: "图表原始尺寸"}));
    expect(screen.getByRole("button", {name: "图表原始尺寸"})).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", {name: "放大图表"}));
    expect(container.querySelector('.diagram-canvas')).toHaveStyle({width: '1000px'});
    fireEvent.click(screen.getByRole("button", {name: "适应图表宽度"}));
    expect(container.querySelector('.diagram-canvas')).toHaveStyle({width: '800px'});
    expect(screen.getByLabelText("依赖关系图")).toHaveAttribute('tabindex', '0');
  });
});
