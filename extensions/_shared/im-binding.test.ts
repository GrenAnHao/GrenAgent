import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimImBinding,
  currentImBinding,
  notifyImBoundElsewhere,
  releaseImBinding,
  __resetImBindingForTest,
} from "./im-binding.js";

afterEach(() => {
  __resetImBindingForTest();
});

describe("ImBinding", () => {
  it("首个 session_start 声明成功", () => {
    expect(claimImBinding("D:/a", "s1")).toEqual({ claimed: true });
    expect(currentImBinding()).toEqual({ workspace: "D:/a", sessionId: "s1" });
  });

  it("同 workspace 切会话跟随更新 sessionId", () => {
    claimImBinding("D:/a", "s1");
    expect(claimImBinding("D:/a", "s2")).toEqual({ claimed: true });
    expect(currentImBinding()).toEqual({ workspace: "D:/a", sessionId: "s2" });
  });

  it("其他 workspace 不能覆盖路由", () => {
    claimImBinding("D:/a", "s1");
    expect(claimImBinding("D:/b", "s9")).toEqual({
      claimed: false,
      owner: { workspace: "D:/a", sessionId: "s1" },
    });
    expect(currentImBinding()).toEqual({ workspace: "D:/a", sessionId: "s1" });
  });

  it("owner 关闭后下一个可以声明", () => {
    claimImBinding("D:/a", "s1");
    releaseImBinding("D:/a");
    expect(currentImBinding()).toBeUndefined();
    expect(claimImBinding("D:/b", "s2")).toEqual({ claimed: true });
  });

  it("非 owner 调用 release 是空操作", () => {
    claimImBinding("D:/a", "s1");
    releaseImBinding("D:/b");
    expect(currentImBinding()).toEqual({ workspace: "D:/a", sessionId: "s1" });
  });

  it("斜杠和大小写不同的同一目录视为同一 workspace", () => {
    expect(claimImBinding("C:\\Users\\rxstudio\\.pi\\agent\\works\\a", "s1")).toEqual({ claimed: true });
    expect(claimImBinding("C:/Users/rxstudio/.pi/agent/works/a", "s2")).toEqual({ claimed: true });
    expect(currentImBinding()?.sessionId).toBe("s2");
  });

  it("冲突提示按 owner 去重，重绑不再弹", () => {
    claimImBinding("D:/a", "s1");
    const notify = vi.fn();
    notifyImBoundElsewhere(notify, currentImBinding()!);
    notifyImBoundElsewhere(notify, currentImBinding()!);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("IM 已绑定到 D:/a", "warning");
  });
});
