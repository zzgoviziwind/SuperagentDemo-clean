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
  await user.click(screen.getByRole("button", { name: "将本次结果填入回复框" }));
  expect((screen.getByLabelText("回复草稿") as HTMLTextAreaElement).value).toBe(
    "本次分析发现索引缺失",
  );
  await user.type(screen.getByLabelText("回复草稿"), "，请复核");
  await user.selectOptions(screen.getByLabelText("回复来源事件"), "4");
  await user.click(screen.getByRole("button", { name: "保存草稿，待审批发送" }));
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

it.each([
  ["failed", 2, "重新编辑回复"],
  [undefined, 1, "复用为新草稿"],
])("失败或历史草稿可复用到当前版本并保留来源 %s", async (status, version, label) => {
  const user = userEvent.setup();
  const fetcher = vi.fn(async (_path: string, options?: RequestInit) => new Response(JSON.stringify(
    options?.method === "POST" ? {} : [{id: 8, event_id: 4, content: "核实后的进展", approval: {status: "approved", revision: version}, delivery: status ? {write_status: status} : null}]
  )));
  vi.stubGlobal("fetch", fetcher);
  render(<DeliveriesPanel taskId="2" revision={2} taskStatus="review_ready" events={[{id:4, source:"redmine", data:{routing_status:"delivered",issue_id:50}}]} approvals={[]} canWrite onChange={changed}/>);
  await user.click(await screen.findByRole("button", {name: label as string}));
  expect(screen.getByText("撰写新的回复草稿").closest("details")?.open).toBe(true);
  expect((screen.getByLabelText("回复草稿") as HTMLTextAreaElement).value).toBe("核实后的进展");
  expect((screen.getByLabelText("回复来源事件") as HTMLSelectElement).value).toBe("4");
  await user.click(screen.getByRole("button", {name:"保存草稿，待审批发送"}));
  await waitFor(()=>expect(fetcher).toHaveBeenCalledWith("/api/v1/tasks/2/deliveries",expect.objectContaining({body:'{"event_id":4,"content":"核实后的进展"}'})));
  expect(fetcher.mock.calls.some(([path])=>path.endsWith("/publish"))).toBe(false);
});

it("回填和复用不会静默覆盖手写正文，复用明确显示新的目标", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([
    { id: 8, event_id: 5, content: "历史回复", approval: { status: "approved", revision: 1 } },
  ]))));
  render(<DeliveriesPanel taskId="2" revision={2} canWrite onChange={changed} approvals={[]}
    artifacts={[{ kind: "summary", revision: 2, content: "新分析结果" }]}
    events={[4, 5].map(id => ({ id, source: "redmine", data: { routing_status: "routed", issue_id: 40 + id } }))} />);
  await user.click(screen.getByText("撰写新的回复草稿"));
  const input = screen.getByLabelText("回复草稿") as HTMLTextAreaElement;
  const source = screen.getByLabelText("回复来源事件") as HTMLSelectElement;
  await user.selectOptions(source, "4");
  await user.type(input, "手写正文");
  await user.click(screen.getByRole("button", { name: "将本次结果填入回复框" }));
  expect(screen.getByRole("dialog", { name: "替换当前回复草稿？" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "保留当前草稿" }));
  expect(input.value).toBe("手写正文");
  expect(source.value).toBe("4");
  await user.click(screen.getByRole("button", { name: "复用为新草稿" }));
  expect(screen.getByRole("dialog").textContent).toContain("Redmine · 问题 #45");
  expect(input.value).toBe("手写正文");
  await user.click(screen.getByRole("button", { name: "替换草稿" }));
  expect(input.value).toBe("历史回复");
  expect(source.value).toBe("5");
});

it("保存等待期间的新输入不被清空，提交内容仍是点击时的版本", async () => {
  const user = userEvent.setup();
  let finishSave!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { finishSave = resolve; });
  const fetcher = vi.fn(async (_path: string, options?: RequestInit) =>
    options?.method === "POST" ? pending : new Response("[]"));
  vi.stubGlobal("fetch", fetcher);
  render(<DeliveriesPanel taskId="2" canWrite onChange={changed} approvals={[]}
    events={[{ id: 4, source: "redmine", data: { routing_status: "routed", issue_id: 50 } }]} />);
  await user.click(screen.getByText("撰写新的回复草稿"));
  const input = screen.getByLabelText("回复草稿") as HTMLTextAreaElement;
  await user.selectOptions(screen.getByLabelText("回复来源事件"), "4");
  await user.type(input, "已提交正文");
  const submit = screen.getByRole("button", { name: "保存草稿，待审批发送" }) as HTMLButtonElement;
  await user.click(submit);
  expect(submit.disabled).toBe(true);
  expect(fetcher).toHaveBeenCalledWith("/api/v1/tasks/2/deliveries", expect.objectContaining({
    body: '{"event_id":4,"content":"已提交正文"}',
  }));
  await user.type(input, "，后来补充");
  finishSave(new Response("{}"));
  await waitFor(() => expect(submit.disabled).toBe(false));
  expect(input.value).toBe("已提交正文，后来补充");
});
