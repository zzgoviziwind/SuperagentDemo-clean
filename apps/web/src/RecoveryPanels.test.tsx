// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InboxPanel } from "./InboxPanel";
import { BudgetReconciliation } from "./BudgetReconciliation";
import { DeliveriesPanel } from "./DeliveriesPanel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const changed = async () => {};

it("收件箱按 after 游标翻页，重试后明确展示仍待确认原因", async () => {
  const user = userEvent.setup();
  const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
    if (options?.method === "POST")
      return new Response(
        JSON.stringify({
          id: 51,
          data: {
            routing_status: "pending_confirmation",
            routing_reason: "actor_unmapped_or_disabled",
          },
        }),
      );
    return new Response(
      JSON.stringify(
        path.includes("after=50")
          ? {
              items: [
                {
                  id: 51,
                  source: "dingtalk",
                  content: "请检查导出",
                  created_at: "2026-11-13T08:00:00+00:00",
                  data: {
                    routing_reason: "actor_unmapped_or_disabled",
                    actor_id: "raw-actor-51",
                    thread_id: "raw-thread-51",
                  },
                },
              ],
              has_more: false,
              next_after: 51,
            }
          : { items: [], has_more: true, next_after: 50 },
      ),
    );
  });
  vi.stubGlobal("fetch", fetcher);
  render(<InboxPanel onChange={changed} />);
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "下一页" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  await user.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByText("钉钉 · 事件 51");
  expect(
    screen.getByText(
      new Date("2026-11-13T08:00:00+00:00").toLocaleString("zh-CN"),
    ),
  ).toBeTruthy();
  const sourceDetails = screen.getByText("raw-actor-51").closest("details")!;
  expect(sourceDetails.open).toBe(false);
  await user.click(screen.getByText("查看来源信息"));
  expect(sourceDetails.open).toBe(true);
  expect(screen.getByText("raw-thread-51")).toBeTruthy();
  await user.click(
    await screen.findByRole("button", { name: "重新路由消息 51" }),
  );
  await screen.findByText("消息仍待确认，发送人尚未绑定系统身份，或身份已停用");
  expect(fetcher).toHaveBeenCalledWith(
    "/api/v1/events?routing_status=pending_confirmation&after=50&limit=50",
    expect.anything(),
  );
  expect(fetcher).toHaveBeenCalledWith(
    "/api/v1/events/51/retry-routing",
    expect.objectContaining({ method: "POST" }),
  );
});

it("未知预算需要实际费用和非空依据，允许实际费用为零", async () => {
  const user = userEvent.setup();
  const fetcher = vi.fn(
    async (_path: string, options?: RequestInit) =>
      new Response(
        options?.method === "POST"
          ? "{}"
          : '[{"id":9,"account_id":"global","task_id":2,"estimate_micros":100}]',
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  render(<BudgetReconciliation onChange={changed} />);
  const button = await screen.findByRole("button", { name: "提交预算对账 9" });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  await user.type(screen.getByLabelText("实际费用（微单位）"), "0");
  await user.type(
    screen.getByLabelText("实际费用依据"),
    "账单确认该次调用未计费",
  );
  await user.click(button);
  await waitFor(() =>
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/budget-reservations/9/reconcile",
      expect.objectContaining({
        body: '{"actual_micros":0,"evidence":"账单确认该次调用未计费"}',
      }),
    ),
  );
});

it("仅将当前目标版本的 summary 文本填入草稿并允许编辑后保存", async () => {
  const user = userEvent.setup();
  const fetcher = vi.fn(
    async (_path: string, options?: RequestInit) =>
      new Response(options?.method === "POST" ? "{}" : "[]"),
  );
  vi.stubGlobal("fetch", fetcher);
  render(
    <DeliveriesPanel
      taskId="2"
      revision={2}
      artifacts={[
        { kind: "summary", revision: 1, content: '{"summary":"旧方案"}' },
        {
          kind: "summary",
          revision: 2,
          content:
            '```json\n{"status":"completed","summary":"本次分析发现索引缺失"}\n```',
        },
      ]}
      events={[
        {
          id: 4,
          source: "redmine",
          content: "问题",
          data: { routing_status: "routed", issue_id: 50 },
        },
      ]}
      approvals={[]}
      canWrite
      onChange={changed}
    />,
  );
  await user.click(screen.getByRole("button", { name: "使用本次分析结果" }));
  expect((screen.getByLabelText("回复草稿") as HTMLTextAreaElement).value).toBe(
    "本次分析发现索引缺失",
  );
  await user.type(screen.getByLabelText("回复草稿"), "，请复核");
  await user.selectOptions(screen.getByLabelText("回复来源事件"), "4");
  await user.click(screen.getByRole("button", { name: "保存回复草稿" }));
  await waitFor(() =>
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/tasks/2/deliveries",
      expect.objectContaining({
        body: '{"event_id":4,"content":"本次分析发现索引缺失，请复核"}',
      }),
    ),
  );
  expect(fetcher.mock.calls.some(([path]) => path.endsWith("/publish"))).toBe(
    false,
  );
});
