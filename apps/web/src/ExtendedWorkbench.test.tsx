// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RoutingPanel } from "./RoutingPanel";
import { OperationsPanel } from "./OperationsPanel";
import { ConversationProvidersPanel } from "./ConversationProvidersPanel";
import { SubscriptionsPanel } from "./ArchitecturePanel";
import { EventCenter } from "./EventCenter";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function api(
  values: Record<string, unknown>,
  write?: (path: string, options: RequestInit) => Response,
) {
  const fetcher = vi.fn(async (path: string, options: RequestInit) => {
    if (options.method !== "GET" && write) return write(path, options);
    return new Response(JSON.stringify(values[path] ?? {}));
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

it("人工纠正使用路由快照版本，失败保留核验证据", async () => {
  const fetcher = api(
    {
      "/api/v1/routing/jobs?after=0&limit=50": {
        items: [
          {
            event_id: 9,
            status: "unknown",
            thread_id: "actual-thread",
            context: {
              tasks: [{ id: 2, title: "修复事件", state_version: 7 }],
            },
          },
        ],
      },
    },
    () => new Response(JSON.stringify({ detail: "版本变化" }), { status: 409 }),
  );
  const user = userEvent.setup();
  render(<RoutingPanel />);
  await user.click(
    await screen.findByRole("button", { name: "人工纠正事件 9" }),
  );
  await user.selectOptions(screen.getByLabelText("分派决定"), "dispatch");
  await user.selectOptions(screen.getByLabelText("快照中的目标事件"), "2");
  await user.type(screen.getByLabelText("判定说明"), "后续补充");
  await user.type(screen.getByLabelText("人工核验证据"), "已核对上下文");
  await user.click(screen.getByRole("button", { name: "提交分派纠正" }));
  await screen.findByRole("alert");
  expect(
    (screen.getByLabelText("人工核验证据") as HTMLTextAreaElement).value,
  ).toBe("已核对上下文");
  const call = fetcher.mock.calls.find(([path]) =>
    path.endsWith("/correction"),
  )!;
  expect(JSON.parse(call[1].body as string)).toEqual({
    decision: {
      action: "dispatch",
      kind: "analysis",
      task_id: 2,
      state_version: 7,
      reason: "后续补充",
    },
    evidence: "已核对上下文",
  });
});

it("设备与守护读取真实接口并支持进入事件介入", async () => {
  api({
    "/api/v1/operations/nodes": { items: [{ id: "node-a", online: false }] },
    "/api/v1/operations/watchdog": {
      enabled: true,
      items: [
        { id: 1, task_id: 2, summary: "目标偏离", action: "needs_human" },
      ],
    },
  });
  const open = vi.fn();
  const user = userEvent.setup();
  render(<OperationsPanel onOpenTask={open} />);
  await screen.findByText("node-a", { selector: "strong" });
  await screen.findAllByText("目标偏离");
  await user.click(screen.getByRole("button", { name: "查看事件并介入" }));
  expect(open).toHaveBeenCalledWith("2");
});

it("ChatGPT能力诊断失败可重试且区分项目同步状态", async () => {
  let failed = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      failed
        ? new Response(JSON.stringify({ detail: "服务尚未就绪" }), {
            status: 503,
          })
        : new Response(
            JSON.stringify({
              items: [
                {
                  id: "chatgpt_project",
                  status: "blocked",
                  reason: "公共契约待支持",
                  capabilities: [],
                },
              ],
            }),
          ),
    ),
  );
  const user = userEvent.setup();
  render(<ConversationProvidersPanel />);
  await screen.findByRole("alert");
  failed = false;
  await user.click(screen.getByRole("button", { name: "重新诊断接入" }));
  await screen.findByText("接入受阻");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("显式订阅与旧引用编号相同仍可分别展示且列表只读", async () => {
  const fetcher = api(
    {
      "/api/v1/tasks": [],
      "/api/v1/subscriptions": {
        items: [
          { id: 1, task_id: 2, route_key: "issue:4" },
          {
            id: 1,
            task_id: 2,
            subscription_type: "explicit",
            thread_id: "chat-a",
            enabled: true,
          },
        ],
      },
    },
    () => new Response("{}"),
  );
  const user = userEvent.setup();
  render(<SubscriptionsPanel projects={[]} onOpenTask={vi.fn()} />);
  await screen.findByText("Redmine / 问题 #4");
  expect(screen.queryByRole("button", {name: "停用订阅"})).toBeNull();
  expect(fetcher.mock.calls.every(([, options]) => options.method === "GET")).toBe(true);
});

it("单条事件展示多个目标并进入各自结果处理页", async () => {
  api({
    "/api/v1/events?routing_status=all&after=0&limit=50": {
      items: [{ id: 8, content: "补充资料" }],
    },
    "/api/v1/events/8/trace": {
      event: { id: 8 },
      attempts: [],
      subscriptions: [],
      deliveries: [],
      target_tasks: [
        { id: 2, title: "事件甲", status: "queued" },
        { id: 3, title: "事件乙", status: "running" },
      ],
    },
  });
  const open = vi.fn();
  const user = userEvent.setup();
  render(
    <EventCenter
      onOpenTask={open}
      onManage={vi.fn()}
      onOpenSession={vi.fn()}
    />,
  );
  await user.click(await screen.findByRole("button", { name: /补充资料/ }));
  await screen.findByRole("button", { name: "查看结果与处理 · 事件乙" });
  await user.click(screen.getByRole("button", { name: "查看结果与处理 · 事件甲" }));
  expect(open).toHaveBeenCalledWith("2");
  await user.click(screen.getByRole("button", { name: "查看结果与处理 · 事件乙" }));
  expect(open).toHaveBeenCalledWith("3");
});

it("设备选择和守护纠正提交实际API", async () => {
  const fetcher = api(
    {
      "/api/v1/operations/nodes": {
        items: [{ id: "node-a", project_ids: [1], online: true }],
        bindings: [],
      },
      "/api/v1/operations/watchdog": {
        items: [{ id: "r1", task_id: 2, status: "unknown" }],
      },
    },
    () => new Response("{}"),
  );
  const user = userEvent.setup();
  render(
    <OperationsPanel
      projects={[{ id: 1, name: "项目甲" }]}
      tasks={[{ id: 2, title: "事件甲" }]}
      onOpenTask={vi.fn()}
    />,
  );
  await screen.findByText("node-a", { selector: "strong" });
  await user.click(screen.getByText("高级执行设备绑定"));
  await user.selectOptions(screen.getByLabelText("设备所属项目"), "1");
  await user.selectOptions(screen.getByLabelText("执行设备"), "node-a");
  await user.click(screen.getByRole("button", { name: "保存设备绑定" }));
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(
        ([path, options]) =>
          path.endsWith("/execution-node") &&
          options.method === "PATCH" &&
          JSON.parse(options.body as string).node_id === "node-a",
      ),
    ).toBe(true),
  );
  await user.click(screen.getByRole("button", { name: "纠正守护判断" }));
  await user.type(
    screen.getByLabelText("守护纠正说明或核验证据"),
    "已核对巡检退出",
  );
  await user.click(screen.getByLabelText("已核验巡检未知结果"));
  await user.click(screen.getByRole("button", { name: "保存守护纠正" }));
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(
        ([path, options]) =>
          path.endsWith("/r1/messages") &&
          JSON.parse(options.body as string).reconcile_unknown === true,
      ),
    ).toBe(true),
  );
});

it("订阅列表不提供新增入口", async () => {
  const fetcher = api(
    {
      "/api/v1/tasks": [
        { id: 2, project_id: 1, title: "事件甲", status: "queued" },
      ],
      "/api/v1/subscriptions": { items: [] },
    },
    () => new Response("{}"),
  );
  const user = userEvent.setup();
  render(
    <SubscriptionsPanel
      projects={[{ id: 1, name: "项目甲" }]}
      onOpenTask={vi.fn()}
    />,
  );
  await screen.findByText(/暂无关联/);
  expect(screen.queryByText("添加事件订阅")).toBeNull();
  expect(fetcher.mock.calls.every(([, options]) => options.method === "GET")).toBe(true);
});

it("手动巡检使用事件执行入口", async () => {
  const timer = vi.spyOn(window, "setTimeout");
  const fetcher = api(
    {
      "/api/v1/operations/nodes": { items: [] },
      "/api/v1/operations/watchdog": { items: [] },
    },
    () => new Response(JSON.stringify({ run_id: "r1" })),
  );
  const user = userEvent.setup();
  render(
    <OperationsPanel
      tasks={[{ id: 2, title: "事件甲" }]}
      onOpenTask={vi.fn()}
    />,
  );
  await user.selectOptions(screen.getByLabelText("立即巡检事件"), "2");
  await user.click(screen.getByRole("button", { name: "执行一次智能巡检" }));
  expect(timer).toHaveBeenCalledWith(expect.any(Function), 260000);
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(
        ([path]) => path === "/api/v1/operations/watchdog/tasks/2/run",
      ),
    ).toBe(true),
  );
});

it("多目标事件展示逐事件执行和持久巡检证据", async () => {
  api({
    "/api/v1/events?routing_status=all&after=0&limit=50": {
      items: [{ id: 8, content: "多目标补充" }],
    },
    "/api/v1/events/8/trace": {
      event: { id: 8 },
      attempts: [],
      subscriptions: [],
      deliveries: [],
      target_subscriptions: [
        { id: 4, thread_id: "chat-multi", source: "dingtalk", task_id: 3 },
      ],
      target_observations: [
        {
          task_id: 3,
          message_event_id: 11,
          scope: "当前目标观察",
          execution: {
            state: "running",
            thread_id: "worker-real",
            events: [
              { id: 12, event_type: "agentMessage", content: "正在核对新资料" },
            ],
          },
          watchdog: {
            outcome_unknown: false,
            runs: [
              {
                id: "watch-real",
                status: "completed",
                thread_id: "watch-thread",
                conclusion: { action: "needs_human", reason: "目标需要补充" },
                evidence: { goal: "目标甲" },
                correction: "按新验收继续",
              },
            ],
          },
        },
      ],
    },
  });
  const user = userEvent.setup();
  const open = vi.fn();
  render(<EventCenter onOpenTask={open} onManage={vi.fn()} />);
  await user.click(await screen.findByRole("button", { name: /多目标补充/ }));
  await user.click(await screen.findByText("处理记录与诊断"));
  await screen.findByText("worker-real");
  await user.click(screen.getByText(/智能巡检 watch-real/));
  await screen.findByText("目标需要补充");
  await screen.findByText("watch-thread");
  await screen.findByText("chat-multi");
  expect(screen.getByText("chat-multi").closest("details")?.open).toBe(false);
  await user.click(
    screen.getByRole("button", { name: "进入目标事件查看与介入" }),
  );
  expect(open).toHaveBeenCalledWith("3");
});
