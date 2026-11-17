import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, controlLabel, request } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("API 请求与运行状态", () => {
  it("409 保留具体预算错误并附刷新提示", async () => {
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response('{"detail":"预算结果未知，需要先对账"}', {
            status: 409,
          }),
        ),
    );
    await expect(
      request("/tasks/2/controls", { action: "resume" }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("预算结果未知，需要先对账"),
    });
  });
  it("发送当前状态版本与同源身份，不在浏览器添加令牌", async () => {
    vi.stubGlobal("window", globalThis);
    const fetcher = vi.fn().mockResolvedValue(new Response('{"id":12}'));
    vi.stubGlobal("fetch", fetcher);
    await request("/tasks/12/controls", {
      action: "pause",
      expected_state_version: 8,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/tasks/12/controls",
      expect.objectContaining({
        credentials: "same-origin",
        body: '{"action":"pause","expected_state_version":8}',
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  it("冲突返回可识别错误，要求刷新后核对", async () => {
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response('{"detail":"版本已变化"}', { status: 409 }),
        ),
    );
    await expect(
      request("/tasks/12/messages", { content: "继续" }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("刷新"),
    });
  });

  it("网络失败可读且不会伪造成功结果", async () => {
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );
    await expect(request("/projects")).rejects.toThrow("输入内容已保留");
  });

  it("保留权限错误内容", async () => {
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response('{"detail":"需要有效的访问凭据"}', { status: 401 }),
        ),
    );
    await expect(request("/projects")).rejects.toBeInstanceOf(ApiError);
  });

  it("执行端未确认停止时展示等待确认", () => {
    expect(controlLabel({ status: "running", stop_requested: true })).toContain(
      "等待执行端确认",
    );
    expect(
      controlLabel({ status: "cancelled", stop_requested_at: "2026-11-13" }),
    ).toBe("已取消");
    expect(controlLabel({ status: "paused" })).toBe("已暂停");
    expect(
      controlLabel({ status: "waiting_resource", last_error: "正在停止执行" }),
    ).toContain("等待执行端确认");
    expect(controlLabel({ status: "waiting_resource" })).toBe("等待资源");
  });
});
