// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GovernancePanel } from "./GovernancePanel";
import { SessionWorkbench } from "./SessionWorkbench";
import { ArchitecturePanel } from "./ArchitecturePanel";
import { EventCenter } from "./EventCenter";
import { VerificationView } from "./VerificationView";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("群卡片侧栏编辑与开关同步右侧摘要", async () => {
  const fetcher = api({ "/api/v1/agents/local": { items: [] } });
  const user = userEvent.setup();
  const { container } = render(
    <GovernancePanel
      settings={{ dingtalk_response_policy: {
        direct_messages: "reply", group_messages: "requests", delivery: "draft",
        group_scope: "selected", group_chat_ids: ["group-a", "group-b"],
        group_names: { "group-a": "项目甲群", "group-b": "项目乙群" },
      } }}
      projects={[]}
      onChange={vi.fn().mockResolvedValue(undefined)}
    />,
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(container.querySelector<HTMLDetailsElement>(".settings-access")?.open).toBe(false);
  expect(screen.getByText("2 个指定群")).toBeTruthy();
  await user.click(screen.getByText("项目甲群"));
  const drawer = screen.getByRole("dialog", { name: "编辑指定群" });
  const input = screen.getAllByLabelText("群备注")[0];
  await user.clear(input);
  await user.type(input, "项目甲协作群");
  expect(screen.getByText("项目甲协作群")).toBeTruthy();
  await user.click(within(drawer).getByRole("switch", { name: "接收此群消息" }));
  await user.click(within(drawer).getByRole("button", { name: "完成，返回列表" }));
  expect(screen.getByText("1 个指定群")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "保存消息与交付方式" }));
  const call = fetcher.mock.calls.find(([path]) => path === "/api/v1/settings")!;
  const policy = JSON.parse(call[1].body as string).dingtalk_response_policy;
  expect(policy.group_chat_ids).toEqual(["group-b"]);
  expect(policy.group_names["group-b"]).toBe("项目乙群");
});

it("开启和关闭的群都可删除，保存后旧配置不会把群重新加回来", async () => {
  const fetcher = api({ "/api/v1/agents/local": { items: [] } });
  const user = userEvent.setup();
  const legacy = { group_names: { enabled: "开启群备注", disabled: "关闭群备注" } };
  const view = render(<GovernancePanel settings={{
    dingtalk_request_access: legacy,
    dingtalk_response_policy: {
      direct_messages: "reply", group_messages: "requests", delivery: "draft",
      default_project_id: null, group_scope: "selected", group_chat_ids: ["enabled"],
      group_names: legacy.group_names,
      group_original_names: { enabled: "开启群原名", disabled: "关闭群原名" },
    },
  }} projects={[]} onChange={vi.fn().mockResolvedValue(undefined)} />);
  expect(screen.getByText("群原名：关闭群原名")).toBeTruthy();
  await user.click(screen.getByText("关闭群备注"));
  await user.click(screen.getByRole("button", { name: "删除此群" }));
  expect(screen.queryByText("关闭群备注")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  await user.click(screen.getByText("开启群备注"));
  await user.click(screen.getByRole("button", { name: "删除此群" }));
  await user.click(screen.getByRole("button", { name: "保存消息与交付方式" }));
  const call = fetcher.mock.calls.find(([path]) => path === "/api/v1/settings")!;
  const policy = JSON.parse(call[1].body as string).dingtalk_response_policy;
  expect(policy.group_chat_ids).toEqual([]);
  expect(policy.group_names).toEqual({});
  expect(policy.group_original_names).toEqual({});
  view.unmount();
  render(<GovernancePanel settings={{ dingtalk_request_access: legacy, dingtalk_response_policy: policy }}
    projects={[]} onChange={vi.fn().mockResolvedValue(undefined)} />);
  expect(screen.queryByText("开启群备注")).toBeNull();
  expect(screen.queryByText("关闭群备注")).toBeNull();
});
function api(values: Record<string, unknown>) {
  const fetcher = vi.fn(
    async (path: string, options: RequestInit) =>
      new Response(
        JSON.stringify(
          options.method === "GET"
            ? (values[path] ?? {})
            : { active_id: "codex", execution_enabled: true },
        ),
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
it("接收范围显示指定群与绑定项目，可保存所有群或关闭指定群", async () => {
  const fetcher = api({ "/api/v1/connectors": [{ name: "dingtalk", status: "running", scopes: [{ kind: "group", chat_id: "group-a", status: "running" }] }] });
  const user = userEvent.setup();
  render(<GovernancePanel settings={{ "connectors.dingtalk": { kind: "group", chat_id: "group-a" } }} projects={[{ id: 1, name: "测试项目", dingtalk_chat_ids: ["group-a"] }]} onChange={vi.fn().mockResolvedValue(undefined)} />);
  await screen.findByText(/群名称待配置/);
  expect((screen.getByLabelText("群接收范围") as HTMLSelectElement).value).toBe("selected");
  await user.selectOptions(screen.getByLabelText("群接收范围"), "all");
  await user.click(screen.getByRole("button", { name: "保存消息与交付方式" }));
  let call = fetcher.mock.calls.filter(([path]) => path === "/api/v1/settings").at(-1)!;
  expect(JSON.parse(call[1].body as string).dingtalk_response_policy.group_scope).toBe("all");
  await user.selectOptions(screen.getByLabelText("群接收范围"), "selected");
  await user.click(screen.getByRole("switch", { name: "未命名群接收开关" }));
  await user.click(screen.getByRole("button", { name: "保存消息与交付方式" }));
  call = fetcher.mock.calls.filter(([path]) => path === "/api/v1/settings").at(-1)!;
  expect(JSON.parse(call[1].body as string).dingtalk_response_policy.group_chat_ids).toEqual([]);
});
it("默认三步配置读取本机Agent，连接复用登录且仅提交业务策略", async () => {
  const fetcher = api({
    "/api/v1/agents/local": {
      active_id: null,
      items: [
        {
          id: "codex",
          name: "Codex",
          installed: true,
          auth_status: "authenticated",
          executable: "C:/private/codex.exe",
        },
        {
          id: "other",
          name: "其他工具",
          installed: true,
          auth_status: "unsupported",
        },
      ],
    },
  });
  const user = userEvent.setup();
  render(
    <GovernancePanel
      settings={{}}
      projects={[{ id: 1, name: "项目甲" }]}
      onChange={vi.fn().mockResolvedValue(undefined)}
    />,
  );
  await screen.findByRole("button", { name: /Codex/ });
  expect(screen.queryByLabelText("Codex 模型")).toBeNull();
  expect(screen.queryByRole("button", { name: "身份与项目授权" })).toBeNull();
  expect(
    (screen.getByRole("button", { name: /其他工具/ }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await user.click(screen.getByRole("button", { name: "使用已有登录连接" }));
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(
        ([path, options]) =>
          path.endsWith("/connect") &&
          JSON.parse(options.body as string).use_existing_login === true,
      ),
    ).toBe(true),
  );
  await user.selectOptions(screen.getByLabelText("群聊响应"), "mentions");
  await user.selectOptions(screen.getByLabelText("交付方式"), "approved_send");
  await user.click(screen.getByRole("button", { name: "保存消息与交付方式" }));
  const call = fetcher.mock.calls.find(
    ([path]) => path === "/api/v1/settings",
  )!;
  expect(JSON.parse(call[1].body as string)).toEqual({
    dingtalk_response_policy: {
      direct_messages: "reply",
      group_messages: "mentions",
      delivery: "approved_send",
      default_project_id: null,
    },
  });
  await user.click(screen.getByText("高级设置 · 权限与外部连接"));
  await screen.findByRole("button", { name: "外部客户端连接" });
});
it("分流会话按原线程提交复核并读取真实可见记录，可进入Worker", async () => {
  const session = {
    id: "semantic:9",
    kind: "routing",
    title: "处理消息",
    project_id: 1,
    status: "applied",
    state_version: 4,
    mode: "agent",
    worker_session_ids: ["worker:2"],
  };
  const fetcher = api({
    "/api/v1/sessions": [session],
    "/api/v1/sessions/semantic%3A9": {
      session,
      messages: [
        {
          id: 1,
          role: "user",
          content: "真实输入",
          data: { source: "model_context" },
        },
      ],
    },
    "/api/v1/sessions/semantic%3A9/transcript": {
      complete: true,
      source: "codex_thread",
      items: [{ id: "a", type: "agentMessage", text: "真实模型输出" }],
    },
    "/api/v1/sessions/worker%3A2": {
      session: {
        ...session,
        id: "worker:2",
        kind: "worker",
        task_kind: "reply",
        task_id: 2,
      },
      messages: [],
    },
  });
  const user = userEvent.setup();
  render(
    <SessionWorkbench
      projects={[]}
      canWrite
      onOpenTask={vi.fn()}
      initialSessionId="semantic:9"
    />,
  );
  await screen.findByText("本次模型输入");
  await user.type(
    screen.getByLabelText("补充说明或纠正方向"),
    "请根据新事实复核",
  );
  await user.click(screen.getByRole("button", { name: "发送到会话" }));
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(
        ([path, options]) =>
          path.endsWith("/messages") &&
          JSON.parse(options.body as string).expected_state_version === 4,
      ),
    ).toBe(true),
  );
  await screen.findByText(/原 Codex 会话：/);
  expect(screen.queryByText("真实模型输出")).toBeNull();
  expect(fetcher.mock.calls.some(([path]) => path.endsWith("/transcript"))).toBe(false);
  await user.click(
    screen.getByRole("button", { name: "查看分派的 Worker · 2" }),
  );
  await screen.findByText(/回复事件 · Worker/);
});
it("拓扑包含订阅绕行、多Worker和定向存储，Fast与Slow同节点", async () => {
  api({ "/api/v1/architecture": { stages: [] } });
  const { container } = render(
    <ArchitecturePanel onNavigate={vi.fn()} isAdmin />,
  );
  const desktop = container.querySelector(".topology-desktop")!;
  expect(desktop.querySelectorAll(".topology-node-filter").length).toBe(1);
  for (const edge of [
    "trigger-filter",
    "filter-router",
    "router-channels",
    "filter-worker",
    "router-worker-a",
    "router-worker-b",
    "router-db",
    "worker-a-db",
    "worker-b-db",
    "watchdog-db",
  ])
    expect(
      desktop
        .querySelector(`[data-edge="${edge}"]`)
        ?.getAttribute("marker-end"),
    ).toBeTruthy();
  expect(
    desktop.querySelector('[data-edge="filter-worker"]')?.getAttribute("class"),
  ).toContain("subscription");
});
it("事件详情可跳这次真实Router判断", async () => {
  api({
    "/api/v1/events?routing_status=all&after=0&limit=50": {
      items: [{ id: 9, content: "新请求" }],
    },
    "/api/v1/events/9/trace": {
      event: { id: 9 },
      attempts: [],
      subscriptions: [],
      deliveries: [],
      routing_session_id: "semantic:9",
      routing_mode: "agent",
    },
  });
  const open = vi.fn();
  const user = userEvent.setup();
  render(
    <EventCenter
      onOpenTask={vi.fn()}
      onManage={vi.fn()}
      onOpenSession={open}
    />,
  );
  await user.click(await screen.findByRole("button", { name: /新请求/ }));
  await user.click(
    await screen.findByRole("button", { name: "查看这次 Router 判断" }),
  );
  expect(open).toHaveBeenCalledWith("semantic:9");
});
it("回复事件核验展示完成与草稿状态", () => {
  render(
    <VerificationView
      data={{
        kind: "reply",
        turn_status: "completed",
        draft_created: true,
        tool_less: true,
      }}
    />,
  );
  expect(screen.getByText("回复生成已完成，发送状态见回复记录")).toBeTruthy();
  expect(screen.queryByText("验证未通过或尚未完整验证")).toBeNull();
});

it("消息范围显示部分故障，显式确认后才启动连接", async () => {
  const fetcher = api({
    "/api/v1/agents/local": { items: [] },
    "/api/v1/connectors": [
      {
        id: "dingtalk",
        configured: true,
        status: "degraded",
        scopes: [
          { kind: "all-direct", status: "running" },
          { kind: "all-group", status: "failed", last_error: "群连接已退出" },
        ],
      },
    ],
  });
  const user = userEvent.setup();
  render(
    <GovernancePanel
      settings={{}}
      projects={[]}
      onChange={vi.fn().mockResolvedValue(undefined)}
    />,
  );
  await screen.findByText("消息接收 · 部分范围连接异常");
  await screen.findByText("群连接已退出", { exact: false });
  await user.click(screen.getByRole("button", { name: "启用消息接收" }));
  expect(fetcher.mock.calls.some(([path]) => path.endsWith("/start"))).toBe(
    false,
  );
  await user.click(screen.getByRole("button", { name: "确认连接并接收" }));
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(
        ([path]) => path === "/api/v1/connectors/dingtalk/start",
      ),
    ).toBe(true),
  );
});

it("平台记录提示使用业务说明", async () => {
  const session = {
    id: "worker:2",
    kind: "worker",
    title: "回复事件",
    project_id: 1,
    status: "paused",
  };
  api({
    "/api/v1/sessions": [session],
    "/api/v1/sessions/worker%3A2": {
      session,
      messages: [],
      transcript: {
        complete: false,
        reason: "完整模型项目记录请读取transcript接口",
      },
    },
  });
  render(
    <SessionWorkbench
      projects={[]}
      canWrite
      onOpenTask={vi.fn()}
      initialSessionId="worker:2"
    />,
  );
  await screen.findByText("当前显示平台记录；原会话可通过上方编号在 Codex 中核对。");
  expect(screen.queryByText("完整模型项目记录请读取transcript接口")).toBeNull();
});
