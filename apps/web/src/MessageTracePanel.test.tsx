// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MessageTracePanel, traceNodes } from "./MessageTracePanel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const event = {
  id: 91,
  source: "dingtalk",
  content: "德阳的依据怎么出的",
  data: {
    routing_status: "pending_confirmation",
    routing_reason: "actor_unmapped_or_disabled",
    actor_id: "disabled-actor",
  },
};
it("未授权消息在授权节点阻塞，后续执行与交付无记录", () => {
  const nodes = traceNodes(event, null, []);
  expect(nodes[2].state).toBe("blocked");
  expect(nodes[4].state).toBe("idle");
  expect(nodes[7].state).toBe("idle");
});
it("未知执行和交付结果保持阻塞，事件完成不会伪造交付", () => {
  const detail = {
    task: { id: 1, status: "completed", outcome_unknown: true },
    events: [],
    artifacts: [],
    approvals: [],
  };
  const nodes = traceNodes(
    { ...event, task_id: 1, data: { routing_status: "routed" } },
    detail,
    [],
  );
  expect(nodes[5].state).toBe("blocked");
  expect(nodes[7].state).toBe("idle");
  expect(
    traceNodes(event, null, [{ delivery: { write_status: "unknown" } }])[7]
      .state,
  ).toBe("blocked");
});
it("真实收件接口驱动图节点，点击授权节点可进入管理入口", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (path: string) =>
        new Response(
          JSON.stringify({
            items: path.includes("pending_confirmation") ? [event] : [],
            has_more: false,
            next_after: 91,
          }),
        ),
    ),
  );
  const manage = vi.fn();
  render(<MessageTracePanel onManage={manage} onOpenTask={vi.fn()} />);
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: /身份与项目授权/ }),
  );
  expect(
    screen.getByRole("button", { name: /身份与项目授权/ }).className,
  ).toContain("blocked");
  await user.click(screen.getByRole("button", { name: "打开管理设置" }));
  expect(manage).toHaveBeenCalledOnce();
});
