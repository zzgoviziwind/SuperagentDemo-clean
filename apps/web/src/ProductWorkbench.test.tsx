// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ArchitecturePanel, SubscriptionsPanel } from "./ArchitecturePanel";
import { EventCenter } from "./EventCenter";
import { SessionWorkbench } from "./SessionWorkbench";
import { ConversationContent } from "./ConversationContent";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const project = { id: 1, name: "测试项目" };
function mockApi(
  values: Record<string, unknown>,
  write?: (path: string, options: RequestInit) => Response,
) {
  const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
    if (options?.method && options.method !== "GET" && write)
      return write(path, options);
    return new Response(JSON.stringify(values[path] ?? {}));
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

it("架构模块展示服务实际能力并跳转对应入口", async () => {
  mockApi({
    "/api/v1/architecture": {
      stages: [
        {
          stage: "slow_filter",
          capability: "可配置 Codex 结构化判定与持久队列",
        },
      ],
      counts: { events: 3, subscriptions: 1 },
    },
  });
  const navigate = vi.fn();
  const user = userEvent.setup();
  render(<ArchitecturePanel onNavigate={navigate} isAdmin />);
  await user.click(
    (await screen.findAllByRole("button", { name: /Slow Filter/ }))[0],
  );
  await screen.findByText("当前服务能力 · 可配置 Codex 结构化判定与持久队列");
  await user.click(screen.getByRole("button", { name: "配置两级过滤 ↗" }));
  expect(navigate).toHaveBeenCalledWith("事件规则");
});

it("事件中心读取全部来源并按服务端持久化次数展示阶段", async () => {
  const receipt = {
    id: 9,
    source: "dingtalk",
    content: "分析异常",
    data: { routing_status: "routed" },
  };
  const fetcher = mockApi({
    "/api/v1/events?routing_status=all&after=0&limit=50": {
      items: [
        receipt,
        { ...receipt, id: 10, source: "redmine", content: "另一条消息" },
      ],
      has_more: false,
    },
    "/api/v1/events/9/trace": {
      event: receipt,
      attempts: [
        {
          attempt: 1,
          steps: [
            {
              stage: "fast_filter",
              status: "passed",
              reason: "identity_project_type_and_input_validated",
            },
            {
              stage: "fast_filter",
              status: "blocked",
              reason: "explicit_request_required",
            },
          ],
        },
        {
          attempt: 2,
          steps: [
            { stage: "router", status: "passed", reason: "created_task" },
          ],
        },
      ],
      task: { id: 2, title: "排查异常", status: "queued" },
      subscriptions: [],
      deliveries: [],
      legacy: false,
    },
  });
  const open = vi.fn();
  const user = userEvent.setup();
  render(<EventCenter onOpenTask={open} onManage={vi.fn()} />);
  await screen.findByText("另一条消息");
  await user.selectOptions(screen.getByLabelText("消息来源"), "dingtalk");
  expect(screen.queryByText("另一条消息")).toBeNull();
  await user.click(screen.getByRole("button", { name: /分析异常/ }));
  await screen.findByText("第 2 次处理");
  expect(screen.getAllByText("快速过滤")).toHaveLength(2);
  expect(screen.getByText("身份、项目、消息类型与输入校验通过")).toBeTruthy();
  await user.click(screen.getByText("处理记录与诊断"));
  await user.click(screen.getByRole("button", { name: "查看执行与验证证据" }));
  expect(open).toHaveBeenCalledWith("2");
  expect(fetcher).toHaveBeenCalledWith(
    "/api/v1/events/9/trace",
    expect.anything(),
  );
});

it("订阅关系展示引用与事件并支持进入事件", async () => {
  mockApi({
    "/api/v1/subscriptions": {
      items: [
        {
          id: 1,
          project_id: 1,
          route_key: "issue:123",
          task_id: 8,
          task_title: "核对报告导出",
        },
        {
          id: 2,
          project_id: 1,
          route_key: "dingtalk:message:long-hash",
          task_id: 9,
          task_title: "排查群消息",
        },
        {
          id: 3,
          project_id: 1,
          route_key: "redmine:message:other-hash",
          task_id: 10,
          task_title: "分析问题评论",
        },
      ],
      scope: "事件引用绑定",
    },
  });
  const open = vi.fn();
  const user = userEvent.setup();
  render(<SubscriptionsPanel projects={[project]} onOpenTask={open} />);
  await screen.findByText("Redmine / 问题 #123");
  expect(screen.getByText("钉钉消息引用")).toBeTruthy();
  expect(screen.getByText("Redmine 事件引用")).toBeTruthy();
  expect(
    screen.getByText("dingtalk:message:long-hash").closest("details")?.open,
  ).toBe(false);
  await user.click(screen.getByRole("button", { name: "核对报告导出 ↗" }));
  expect(open).toHaveBeenCalledWith("8");
});

it("Worker人工纠正携带版本，失败保留文本并展示可读报告", async () => {
  const session = {
    id: "worker:2",
    kind: "worker",
    title: "修复导出",
    project_id: 1,
    task_id: 2,
    status: "running",
    mode: "codex",
    state_version: 7,
  };
  const fetcher = mockApi(
    {
      "/api/v1/sessions": [session],
      "/api/v1/sessions/worker%3A2": {
        session,
        messages: [
          {
            id: 1,
            role: "assistant",
            content: '{"summary":"已定位异常","status":"blocked"}',
          },
        ],
      },
    },
    () => new Response('{"detail":"状态已变化"}', { status: 409 }),
  );
  const user = userEvent.setup();
  render(
    <SessionWorkbench projects={[project]} canWrite onOpenTask={vi.fn()} />,
  );
  await user.click(await screen.findByRole("button", { name: /修复导出/ }));
  await screen.findByText("已定位异常");
  await user.type(screen.getByLabelText("补充说明或纠正方向"), "先核对空数据");
  await user.click(screen.getByLabelText("作为新的事件目标提交"));
  await user.click(screen.getByRole("button", { name: "发送到会话" }));
  await screen.findByRole("alert");
  expect(
    (screen.getByLabelText("补充说明或纠正方向") as HTMLTextAreaElement).value,
  ).toBe("先核对空数据");
  expect(fetcher).toHaveBeenCalledWith(
    "/api/v1/sessions/worker%3A2/messages",
    expect.objectContaining({
      body: '{"content":"先核对空数据","change_goal":true,"expected_state_version":7}',
    }),
  );
});

it("Router规则模式展示控制备注和真实消息处理状态", async () => {
  const session = {
    id: "router:1",
    kind: "router",
    title: "测试项目",
    project_id: 1,
    status: "idle",
    mode: "rules",
    state_version: 1,
  };
  mockApi({
    "/api/v1/sessions": [session],
    "/api/v1/sessions/router%3A1": {
      session,
      messages: [
        {
          id: 1,
          role: "user",
          content: "优先处理异常",
          data: { status: "not_sent" },
        },
      ],
    },
  });
  const user = userEvent.setup();
  render(
    <SessionWorkbench projects={[project]} canWrite onOpenTask={vi.fn()} />,
  );
  await user.click(
    await screen.findByRole("button", { name: /项目讨论/ }),
  );
  await screen.findByText("尚未发送给代理");
  expect(screen.getByRole("button", { name: "保存控制备注" })).toBeTruthy();
  expect(screen.getByText(/项目讨论代理未启用/)).toBeTruthy();
});

it("结构化报告摘要可直接阅读，原始报告默认折叠", () => {
  render(
    <ConversationContent
      content={
        '{"summary":"需要补齐测试","status":"blocked","evidence":["读取入口文件"]}'
      }
    />,
  );
  expect(screen.getByText("需要补齐测试")).toBeTruthy();
  expect(screen.getByText("受阻")).toBeTruthy();
  const details = screen.getByText("查看原始报告").closest("details")!;
  expect(details.open).toBe(false);
  expect(within(details).getByText(/summary/)).toBeTruthy();
});



