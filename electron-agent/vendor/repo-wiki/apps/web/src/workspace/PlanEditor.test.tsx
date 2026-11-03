import { useState } from "react";
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PlanEditor } from "./PlanEditor";
function Harness({
  initial = '{"include":["src/**"],"pages":[]}',
}: {
  initial?: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <PlanEditor value={value} onChange={setValue} />
      <output data-testid="value">{value}</output>
    </>
  );
}
describe("Wiki generation plan", () => {
  it("edits scope and page goals through structured fields with actual JSON roundtrip", () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("包含路径"), {
      target: { value: "src/**\nlib/**" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加页面" }));
    fireEvent.change(screen.getByLabelText("页面 1 写作目标"), {
      target: { value: "解释请求的认证过程" },
    });
    const value = JSON.parse(screen.getByTestId("value").textContent!);
    expect(value.include).toEqual(["src/**", "lib/**"]);
    expect(value.pages[0].goal).toBe("解释请求的认证过程");
    fireEvent.click(screen.getByRole("button", { name: "高级 JSON" }));
    expect(screen.getByLabelText("Wiki 计划 JSON")).toHaveValue(
      JSON.stringify(value, null, 2),
    );
  });
  it("keeps malformed drafts editable and never silently resets them", () => {
    render(<Harness initial="{broken" />);
    expect(screen.getByLabelText("Wiki 计划 JSON")).toHaveValue("{broken");
    expect(screen.getByText(/当前 JSON 无法/)).toBeInTheDocument();
  });
  it("removes a page only in the unsaved draft", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "添加页面" }));
    fireEvent.click(screen.getByRole("button", { name: "移除页面 1" }));
    expect(JSON.parse(screen.getByTestId("value").textContent!).pages).toEqual(
      [],
    );
  });
  it("lets a user type a new line before entering the next path", () => {
    render(<Harness />);
    const input = screen.getByLabelText("包含路径");
    fireEvent.change(input, { target: { value: "src/**\n" } });
    expect(input).toHaveValue("src/**\n");
    fireEvent.change(input, { target: { value: "src/**\nlib/**" } });
    expect(
      JSON.parse(screen.getByTestId("value").textContent!).include,
    ).toEqual(["src/**", "lib/**"]);
  });
});
