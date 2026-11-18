// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./main";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const project = {
  id: 1,
  name: "验收仓库",
  enabled: true,
  repo_path: "E:/test",
  base_branch: "main",
};
const task = {
  id: 2,
  title: "修复导出",
  goal: "修复超时",
  project_id: 1,
  status: "running",
  revision: 1,
  state_version: 3,
  source: "web",
};

function setup(
  write: (path: string, options?: RequestInit) => Response,
  role = "admin",
  connectors: Record<string, unknown>[] = [],
  taskOverrides: Record<string, unknown> = {},
  replyFixtures = false,
  approvals: Record<string, unknown>[] = [],
) {
  const currentTask = { ...task, ...taskOverrides };
  const secondTask = { ...task, id: 3, title: "另一个事件" };
  const firstSource = { id: 42, source: replyFixtures ? "redmine" : "web", content: "修复导出", created_at: "2026-11-15T00:00:00Z", data: { routing_status: "routed", issue_id: 50 } };
  const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
    if (options?.method && options.method !== "GET")
      return write(path, options);
    if (path.startsWith("/api/v1/event-groups/index")) return new Response(JSON.stringify({items:[
      { key: "group:2", group: currentTask, messages: [firstSource] },
      ...(replyFixtures ? [{ key: "group:3", group: secondTask, messages: [] }] : []),
    ], total: replyFixtures ? 2 : 1, has_more: false}));
    if (path.startsWith("/api/v1/events?")) return new Response(JSON.stringify({items:[{id:42,source:"web",content:"修复导出",task_id:2,data:{routing_status:"routed"}}],has_more:false}));
    const responses: Record<string, unknown> = {
      "/api/v1/events/42/trace": {event:{id:42,source:"web",content:"修复导出",task_id:2,data:{routing_status:"routed"}},task:currentTask,attempts:[],subscriptions:[],deliveries:[],execution:{events:[],artifacts:[],approvals:[]},live_stages:[]},
      "/health": { status: "ok", version: "test" },
      "/api/v1/projects": [project],
      "/api/v1/tasks": [currentTask],
      "/api/v1/event-groups": [currentTask],
      "/api/v1/event-groups/2": {group:currentTask, events:[],following:[]},
      "/api/v1/connectors": connectors,
      "/api/v1/identities": [],
      "/api/v1/budgets": [],
      "/api/v1/audit?limit=100": [],
      "/api/v1/overview": { counts: {} },
      "/api/v1/settings": {},
      "/api/v1/auth/me": { role, name: "测试用户" },
      "/api/v1/tasks/2/deliveries": [],
      "/api/v1/tasks/2/handoff": {},
      "/api/v1/tasks/2": {
        task: currentTask,
        events: replyFixtures ? [firstSource] : [],
        artifacts: [],
        approvals,
      },
      "/api/v1/tasks/3": { task: secondTask, events: [], artifacts: [], approvals: [] },
      "/api/v1/tasks/3/deliveries": [],
      "/api/v1/tasks/3/handoff": {},
    };
    return new Response(JSON.stringify(responses[path] ?? {}));
  });
  vi.stubGlobal("fetch", fetcher);
  render(<App />);
  return fetcher;
}

describe("工作台关键交互", () => {
  it("飞书链接打开当前审批并聚焦，打开链接本身不提交决定", async () => {
    window.history.replaceState(null, "", "/?task=2&approval=17");
    const write = vi.fn(() => new Response("{}"));
    let focusWhenApprovalAppeared: Element | null | undefined;
    const observer = new MutationObserver(() => {
      if (document.querySelector("[data-execution-approval]") && focusWhenApprovalAppeared === undefined) {
        focusWhenApprovalAppeared = document.activeElement;
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    try {
      setup(write, "admin", [], { status: "waiting_approval", control_version: 3 }, false,
        [{ id: 17, status: "pending", revision: 1, control_version: 3, action_hash: "current", action: { method: "item/fileChange/requestApproval" } }]);
      const approve = await screen.findByRole("button", { name: "批准" }, { timeout: 3000 });
      const article = approve.closest("article");
      expect(document.activeElement).toBe(article);
      expect(focusWhenApprovalAppeared).toBe(article);
      const user = userEvent.setup();
      await user.tab();
      expect(document.activeElement).toBe(article?.querySelector("summary"));
      await user.tab();
      expect(document.activeElement).toBe(approve);
      expect(write).not.toHaveBeenCalled();
    } finally {
      observer.disconnect();
    }
  });

  it("飞书旧链接显示审批失效并隐藏过期操作", async () => {
    window.history.replaceState(null, "", "/?task=2&approval=17");
    setup(() => new Response("{}"), "admin", [], { status: "waiting_approval", control_version: 3 }, false,
      [{ id: 17, status: "pending", revision: 1, control_version: 2, action_hash: "stale" }]);
    expect(await screen.findByText(/此链接对应的审批已处理或失效/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "批准" })).toBeNull();
  });

  it("事件中心使用满高工作区，账号位于顶栏且分派复核可从左侧进入", async () => {
    const user = userEvent.setup();
    setup(() => new Response("{}"));
    const account = await screen.findByText("测试用户");
    expect(account.closest("header.ide-toolbar")).toBeTruthy();
    expect(account.closest("details")?.open).toBe(false);
    expect(document.querySelector("main.event-center-page")).toBeTruthy();
    expect(document.querySelector("main > header.workbench-page-heading")?.textContent).toContain("事件中心");
    expect(document.querySelector("main>footer")).toBeNull();
    expect(screen.getAllByRole("button", { name: "＋ 提出事件" })).toHaveLength(1);
    await user.click(await screen.findByRole("button", { name: /修复导出/ }));
    expect(screen.queryByText("处理设置")).toBeNull();
    expect(screen.queryByText(/导出事件完整快照/)).toBeNull();
    expect(screen.getByText("事件处理")).toBeTruthy();
    await user.click(screen.getByLabelText("更多工具"));
    await user.click(screen.getByRole("button", { name: "分派复核" }));
    expect(await screen.findByRole("heading", { name: "分派管理与人工复核" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "系统如何工作" })).toBeNull();
    expect(document.querySelector("main > header.workbench-page-heading")?.textContent).toContain("分派复核");
    await user.click(screen.getByRole("button", {name:"Worker 工作台"}));
    expect(document.querySelector(".relation-nav")).toBeNull();
    expect(document.querySelector("main.worker-page")).toBeTruthy();
  });

  it("未知执行结果要求核验证据并携带状态版本对账", async () => {
    const user = userEvent.setup();
    const fetcher = setup(() => new Response("{}"), "admin", [], {
      status: "waiting_resource",
      outcome_unknown: true,
    });
    await user.click(screen.getByRole("button", { name: "事件中心" }));
    await user.click(await screen.findByRole("button", { name: /修复导出/ }));
    await screen.findByText("执行结果未知");
    expect(
      (
        screen.getByRole("button", {
          name: "提交执行对账",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await user.type(
      screen.getByLabelText("执行核验证据"),
      "进程已停止，确认保留现有记录并放弃任务",
    );
    expect((screen.getByRole("button", { name: "提交执行对账" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "结束事件" }) as HTMLButtonElement).disabled).toBe(true);
    await user.selectOptions(screen.getByLabelText("执行对账结果"), "abandoned");
    await user.click(screen.getByRole("button", { name: "提交执行对账" }));
    await waitFor(() =>
      expect(fetcher).toHaveBeenCalledWith(
        "/api/v1/tasks/2/reconcile",
        expect.objectContaining({
          body: '{"outcome":"abandoned","evidence":"进程已停止，确认保留现有记录并放弃任务","expected_state_version":3}',
        }),
      ),
    );
  });

  it("新项目默认只读，跨项目读取与改动范围独立", async () => {
    const user = userEvent.setup();
    const fetcher = setup(() => new Response("{}"));
    await screen.findByText("测试用户");
    await user.click(screen.getByRole("button", { name: "项目设置" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "＋ 添加项目" }));
    await user.type(screen.getByLabelText("项目名称"), "分析仓库");
    await user.type(screen.getByLabelText("项目根目录"), "E:/analysis");
    expect(
      (screen.getByLabelText("改动验收范围") as HTMLSelectElement).required,
    ).toBe(true);
    expect((screen.getByLabelText("改动验收范围") as HTMLSelectElement).value).toBe("none");
    await user.selectOptions(screen.getByLabelText("Agent 读取范围"), "projects");
    await user.click(screen.getByRole("button", { name: "保存项目" }));
    await waitFor(() =>
      expect(fetcher).toHaveBeenCalledWith(
        "/api/v1/projects",
        expect.objectContaining({
          body: expect.stringMatching(/"reference_access":"projects".*"allowed_paths":\[\]/),
        }),
      ),
    );
  });
  it("连接器展示目标并等待用户明确确认后才发送启用请求", async () => {
    const user = userEvent.setup();
    const fetcher = setup(() => new Response("{}"), "admin", [
      {
        id: "dingtalk",
        name: "钉钉",
        configured: true,
        enabled: false,
        status: "disabled",
      },
    ]);
    await screen.findByText("测试用户");
    await user.click(screen.getByRole("button", { name: "运行状态" }));
    await user.click(await screen.findByRole("button", { name: "启用连接" }));
    await screen.findByText(/启用后将监听以下项目目标/);
    expect(fetcher.mock.calls.some(([path]) => path.endsWith("/start"))).toBe(
      false,
    );
    await user.click(screen.getByRole("button", { name: "确认启用" }));
    await waitFor(() =>
      expect(fetcher).toHaveBeenCalledWith(
        "/api/v1/connectors/dingtalk/start",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });
  it("401 展示会话登录入口，登录令牌不会写入浏览器存储", async () => {
    const user = userEvent.setup();
    let loggedIn = false;
    const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
      if (path.endsWith("/auth/logout")) {
        loggedIn = false;
        return new Response('{"logged_out":true}');
      }
      if (path.endsWith("/auth/login")) {
        loggedIn = true;
        return new Response('{"role":"admin","name":"管理员"}');
      }
      if (!loggedIn)
        return new Response('{"detail":"请登录"}', { status: 401 });
      if (path.endsWith("/auth/me"))
        return new Response('{"role":"admin","name":"管理员"}');
      if (
        ["/tasks", "/projects", "/connectors"].some((suffix) =>
          path.endsWith(suffix),
        )
      )
        return new Response("[]");
      return new Response("{}");
    });
    vi.stubGlobal("fetch", fetcher);
    render(<App />);
    const token = await screen.findByLabelText("访问令牌");
    expect(token.getAttribute("type")).toBe("password");
    await user.type(token, "test-only-token");
    await user.click(
      within(token.closest("form")!).getByRole("button", { name: "登录" }),
    );
    await screen.findByText("管理员");
    expect(screen.queryByLabelText("访问令牌")).toBeNull();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/auth/login",
      expect.objectContaining({
        credentials: "same-origin",
        body: '{"token":"test-only-token"}',
      }),
    );
    await user.click(screen.getByRole("button", { name: "登出" }));
    expect(
      ((await screen.findByLabelText("访问令牌")) as HTMLInputElement).value,
    ).toBe("");
  });

  it("只读角色隐藏创建与任务写入操作", async () => {
    const user = userEvent.setup();
    setup(() => new Response("{}"), "viewer");
    await screen.findByText("测试用户");
    expect(screen.queryByRole("button", { name: "＋ 提出事件" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "事件中心" }));
    await user.click(await screen.findByRole("button", { name: /修复导出/ }));
    await screen.findByText("当前目标");
    expect(screen.queryByRole("button", { name: "暂停" })).toBeNull();
    expect(screen.queryByRole("button", { name: "添加补充" })).toBeNull();
  });
  it("新建弹窗响应原生取消事件，取消后回到提出事件按钮", async () => {
    const user = userEvent.setup();
    setup(() => new Response("{}"));
    const opener = await screen.findByRole("button", { name: "＋ 提出事件" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "提出事件" });
    expect(document.activeElement).toBe(within(dialog).getByLabelText("项目"));
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("选中旧事件时新建事件，跳到正确详情和处理区，即使新事件不在当前列表", async () => {
    const created = { ...task, id: 99, title: "新登记的事件", status: "queued" };
    const fetcher = setup(() => new Response(JSON.stringify(created)));
    const fallback = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (path, options) => {
      if (path === "/api/v1/event-groups/99") return new Response(JSON.stringify({ group: created, events: [] }));
      if (path === "/api/v1/tasks/99") return new Response(JSON.stringify({ task: created, events: [], artifacts: [], approvals: [] }));
      if (path.startsWith("/api/v1/tasks/99/")) return new Response("[]");
      return fallback(path, options);
    });
    const user = userEvent.setup();
    const oldChoice = await screen.findByRole("button", { name: /修复导出/ });
    await user.click(oldChoice);
    await screen.findByRole("heading", { name: task.title });
    await user.click(screen.getByRole("button", { name: "＋ 提出事件" }));
    await user.selectOptions(screen.getByLabelText("项目"), "1");
    await user.type(screen.getByLabelText("问题标题"), created.title);
    await user.type(screen.getByLabelText("目标"), "检验事件跳转");
    await user.click(screen.getByRole("button", { name: "登记事件" }));
    const heading = await screen.findByRole("heading", { name: created.title });
    expect(document.activeElement).toBe(heading);
    expect(screen.queryByRole("heading", { name: task.title })).toBeNull();
    expect(oldChoice.getAttribute("aria-pressed")).toBe("false");
    expect(heading.closest(".event-detail")?.querySelector(".event-inline-operations")).toBeTruthy();
  });

  it("事件中心默认展示总览，合并待处理计数并保留筛选和事件诊断", async () => {
    const fetcher = setup(() => new Response('{"detail":"本机 Codex 仍不可用"}', { status: 409 }), "admin", [], {
      status:"waiting_resource", kind:"reply", last_error:"本机回复引擎配置无效，请在 Agent 页面检查连接",
    });
    const fallback = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (path, options) => {
      const response = await fallback(path, options);
      if (!path.startsWith("/api/v1/event-groups/index?")) return response;
      const data = await response.json();
      return new Response(JSON.stringify({ ...data, counts: { review: 2, attention: 1, completed: 3, closed: 1 } }));
    });
    const user = userEvent.setup();
    const overview = await screen.findByRole("heading", {name:"架构总览"});
    expect(overview.closest(".event-detail")).toBeTruthy();
    expect(within(overview.closest(".event-overview") as HTMLElement).getByText("两级过滤", { selector: "dt" })).toBeTruthy();
    expect(within(screen.getByRole("navigation", {name:"主导航"})).queryByRole("button", {name:"架构总览"})).toBeNull();
    expect(screen.queryByRole("combobox", {name:"项目范围"})).toBeNull();
    await user.click(screen.getByRole("button", {name:"筛选"}));
    await user.selectOptions(screen.getByLabelText("项目范围"), "1");
    await user.click(screen.getByRole("button", {name:"筛选（1）"}));
    expect(screen.queryByRole("combobox", {name:"项目范围"})).toBeNull();
    expect(await screen.findByRole("button", {name:"已结束 4"})).toBeTruthy();
    await user.click(await screen.findByRole("button", {name:"待处理 3"}));
    expect(screen.getByText(/可能在等待补充、审批或验收/)).toBeTruthy();
    const graph = overview.closest(".event-overview")?.querySelector(".topology-desktop");
    expect(graph?.querySelector(".topology-node-worker")?.getAttribute("data-status-related")).toBe("true");
    expect(graph?.querySelector(".topology-node-delivery")?.getAttribute("data-status-related")).toBe("true");
    expect(graph?.querySelector(".topology-node-router")?.hasAttribute("data-status-related")).toBe(false);
    const card = await screen.findByRole("button", {name:/修复导出/});
    await waitFor(() => expect(fetcher.mock.calls.map(([url])=>url).find(url=>url.includes("status=needs_action"))).toContain("project_id=1"));
    await user.click(card);
    expect(screen.queryByRole("heading", {name:"架构总览"})).toBeNull();
    expect(screen.getByText(/本轮回复尚未启动/)).toBeTruthy();
    await user.click(await screen.findByRole("button", {name:"重新执行回复"}));
    await waitFor(()=>expect(fetcher).toHaveBeenCalledWith("/api/v1/tasks/2/controls",expect.objectContaining({
      body:'{"action":"resume","expected_state_version":3}',
    })));
    await user.click(screen.getByRole("button", {name:"检查本机 Agent"}));
    await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url === "/api/v1/agents/local")).toBe(true));
    expect(screen.queryByRole("button", {name:"返回待恢复事件"})).toBeNull();
    await screen.findByRole("heading", {name:"修复导出"});
    const returnedCard = await screen.findByRole("button", {name:/修复导出/});
    await user.click(screen.getByRole("button", {name:"返回事件列表"}));
    expect(screen.queryByRole("heading", {name:"修复导出"})).toBeNull();
    expect(screen.getByRole("heading", {name:"架构总览"})).toBeTruthy();
    expect(document.activeElement).toBe(returnedCard);
    await user.click(screen.getByRole("button", {name:"筛选（1）"}));
    expect((screen.getByRole("combobox", {name:"项目范围"}) as HTMLSelectElement).value).toBe("1");
    expect(screen.getByRole("button", {name:"待处理 3"}).getAttribute("aria-pressed")).toBe("true");
  });

  it("事件中心定时读取只请求所选事件，慢请求不重叠，提交错误与草稿保留", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    try {
      const fetcher = setup(() => new Response('{"detail":"模拟提交失败"}', { status: 500 }));
      const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
      await tick(0);
      await tick(250);
      fireEvent.click(screen.getByRole("button", { name: /修复导出/ }));
      await tick(0);
      const content = screen.getByLabelText("要求内容") as HTMLTextAreaElement;
      fireEvent.change(content, { target: { value: "保留未提交文字" } });
      fireEvent.click(screen.getByRole("button", { name: "添加补充" }));
      await tick(0);
      expect(screen.getByText("模拟提交失败")).toBeTruthy();

      let finish!: (res: Response) => void;
      const fallback = fetcher.getMockImplementation()!;
      fetcher.mockImplementation((path, options) => path === "/api/v1/tasks/2"
        ? new Promise(resolve => { finish = resolve; })
        : fallback(path, options));
      const start = fetcher.mock.calls.length;
      await tick(10_100);
      expect(fetcher.mock.calls.slice(start).map(([url]) => url).filter(url =>
        /^\/api\/v1\/(tasks(?:\/2)?|projects|connectors|settings|auth\/me)$/.test(url) || url === "/health",
      )).toEqual(["/api/v1/tasks/2"]);
      await act(async () => finish(new Response(JSON.stringify({ task, events: [], artifacts: [], approvals: [] }))));
      expect(screen.getByText("模拟提交失败")).toBeTruthy();
      expect(content.value).toBe("保留未提交文字");
    } finally {
      visibility.mockRestore();
      vi.useRealTimers();
    }
  });

  it("创建失败保留目标并展示错误", async () => {
    const user = userEvent.setup();
    const fetcher = setup(() => {
      throw new TypeError("offline");
    });
    await screen.findByRole("button", { name: "＋ 提出事件" });
    expect(screen.queryByText("事件池")).toBeNull();
    await user.click(screen.getByRole("button", { name: "＋ 提出事件" }));
    await user.selectOptions(screen.getByLabelText("项目"), "1");
    expect((screen.getByLabelText("处理方式") as HTMLSelectElement).value).toBe(
      "repair",
    );
    await user.selectOptions(screen.getByLabelText("处理方式"), "analysis");
    await user.type(screen.getByLabelText("问题标题"), "新修复");
    await user.type(screen.getByLabelText("目标"), "保留我的目标");
    await user.click(screen.getByRole("button", { name: "登记事件" }));
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("alert")
          .some((node) => node.textContent?.includes("输入内容已保留")),
      ).toBe(true),
    );
    expect((screen.getByLabelText("目标") as HTMLTextAreaElement).value).toBe(
      "保留我的目标",
    );
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/tasks",
      expect.objectContaining({
        body: expect.stringContaining('"kind":"analysis"'),
      }),
    );
  });

  it("补充要求携带版本，冲突后保留文本并提示刷新", async () => {
    const user = userEvent.setup();
    const fetcher = setup(
      () => new Response('{"detail":"状态已变化"}', { status: 409 }),
    );
    await user.click(screen.getByRole("button", { name: "事件中心" }));
    await user.click(await screen.findByRole("button", { name: /修复导出/ }));
    await user.click(await screen.findByText("补充给 Agent"));
    await user.type(await screen.findByLabelText("要求内容"), "兼容旧字段");
    await user.click(screen.getByRole("button", { name: "添加补充" }));
    await screen.findByText(/请刷新后核对最新状态/);
    expect(
      (screen.getByLabelText("要求内容") as HTMLTextAreaElement).value,
    ).toBe("兼容旧字段");
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/tasks/2/messages",
      expect.objectContaining({
        body: '{"content":"兼容旧字段","change_goal":false,"expected_state_version":3}',
      }),
    );
  });

  it("保存补充后在事件消息里马上显示", async () => {
    let saved = false;
    const fetcher = setup((path) => {
      if (path === "/api/v1/tasks/2/messages") saved = true;
      return new Response("{}");
    });
    const fallback = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (path, options) => {
      if (saved && path === "/api/v1/tasks/2" && (!options?.method || options.method === "GET")) {
        return new Response(JSON.stringify({
          task: {...task, state_version: 4}, artifacts: [], approvals: [],
          events: [{id: 78, source: "web", event_type: "message", content: "核对德阳的测试分支",
                    created_at: "2026-11-16T01:00:00Z", data: {actor: "操作者"}}],
        }));
      }
      return fallback(path, options);
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", {name: /修复导出/}));
    await user.click(await screen.findByText("补充给 Agent"));
    await user.type(screen.getByLabelText("要求内容"), "核对德阳的测试分支");
    await user.click(screen.getByRole("button", {name: "添加补充"}));
    const item = await screen.findByText("核对德阳的测试分支", {selector: "li p"});
    expect(item.closest("li")?.textContent).toContain("操作者");
  });

  it("暂停请求成功后等待执行端确认，保持真实运行状态", async () => {
    const user = userEvent.setup();
    setup(() => new Response(JSON.stringify({ ...task, state_version: 4, status: "waiting_resource", last_error: "正在停止执行" })));
    await user.click(screen.getByRole("button", { name: "事件中心" }));
    await user.click(await screen.findByRole("button", { name: /修复导出/ }));
    await user.click(await screen.findByRole("button", { name: "暂停" }));
    await screen.findByText("已请求停止 · 等待执行端确认");
    expect(screen.queryByText("已暂停", { exact: true, selector: ".badge" })).toBeNull();
  });

  it("切换事件后保留各自未保存的回复正文和来源", async () => {
    const user = userEvent.setup();
    setup(() => new Response("{}"), "admin", [], {}, true);
    await user.click(await screen.findByRole("button", { name: /修复导出/ }));
    await user.click(await screen.findByText("撰写新的回复草稿"));
    await user.selectOptions(screen.getByLabelText("回复来源事件"), "42");
    await user.type(screen.getByLabelText("回复草稿"), "手写回复");

    await user.click(screen.getByRole("button", { name: /另一个事件/ }));
    const secondEditor = await screen.findByText("撰写新的回复草稿");
    if (!secondEditor.closest("details")?.open) await user.click(secondEditor);
    expect((screen.getByLabelText("回复草稿") as HTMLTextAreaElement).value).toBe("");
    await user.type(screen.getByLabelText("回复草稿"), "另一个事件的草稿");

    await user.click(screen.getByRole("button", { name: /修复导出/ }));
    const firstEditor = await screen.findByText("撰写新的回复草稿");
    if (!firstEditor.closest("details")?.open) await user.click(firstEditor);
    expect((screen.getByLabelText("回复草稿") as HTMLTextAreaElement).value).toBe("手写回复");
    expect((screen.getByLabelText("回复来源事件") as HTMLSelectElement).value).toBe("42");
  });

  it("结束暂停事件必须确认，成功提示按返回状态显示", async () => {
    const user = userEvent.setup();
    const fetcher = setup(() => new Response(JSON.stringify({ ...task, status: "cancelled", state_version: 4 })), "admin", [], { status: "paused" });
    await user.click(await screen.findByRole("button", { name: /修复导出/ }));
    await user.click(await screen.findByRole("button", { name: "结束事件" }));
    expect(fetcher.mock.calls.some(([path]) => path.endsWith("/controls"))).toBe(false);
    await user.click(within(screen.getByRole("dialog", { name: "结束此事件？" })).getByRole("button", { name: "确认结束事件" }));
    await screen.findByRole("button", { name: "恢复原任务" });
    expect(screen.getAllByText("事件已结束，处理记录和原消息已保留。").length).toBeGreaterThan(0);
    expect(screen.queryByText("已请求停止 · 等待执行端确认")).toBeNull();
  });
});

it("管理员可从独立导航直接进入管理设置与事件中心", async () => {
  setup(() => new Response("{}"));
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "管理设置" }));
  await screen.findByRole("heading", { name: "开始使用", level: 2 });
  await user.click(screen.getByText("高级设置 · 权限与外部连接"));
  await user.click(screen.getByRole("button", { name: "身份与项目授权" }));
  expect(screen.getByRole("button", { name: "保存身份授权" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "事件中心" }));
  await screen.findByRole("heading", { name: /事件 1/, level: 2 });
});

it("编辑项目只提交可写字段并保持明确选中状态", async () => {
  const user = userEvent.setup();
  const fetcher = setup(() => new Response("{}"));
  await screen.findByText("测试用户");
  await user.click(screen.getByRole("button", { name: "项目设置" }));
  const row = screen.getByRole("button", { name: /验收仓库/ });
  await user.click(row);
  expect(row.getAttribute("aria-pressed")).toBe("true");
  expect(row.classList.contains("selected")).toBe(true);
  await user.click(screen.getByRole("button", { name: "保存项目" }));
  await waitFor(() => expect(fetcher.mock.calls.some(([path, options]) => path === "/api/v1/projects/1" && options?.method === "PATCH")).toBe(true));
  const [, options] = fetcher.mock.calls.find(([path, options]) => path === "/api/v1/projects/1" && options?.method === "PATCH")!;
  const body = JSON.parse(options!.body as string);
  expect(body.name).toBe("验收仓库");
  expect(body.id).toBeUndefined();
  expect(body.archived).toBeUndefined();
  expect(body.created_at).toBeUndefined();
});

it.each(["resume", "analyze"])("取消事件的 %s 操作携带版本，失败在按钮旁显示", async action => {
  const user = userEvent.setup();
  const fetcher = setup(() => new Response('{"detail":"当前状态不支持此操作"}', {status:409}), "admin", [], {status:"cancelled",kind:"reply"});
  await user.click(screen.getByRole("button", {name:"事件中心"}));
  await user.click(await screen.findByRole("button", {name:/修复导出/}));
  const button = await screen.findByRole("button", {name:action === "resume" ? "恢复原任务" : "改为只读分析"});
  await user.click(button);
  await waitFor(()=>expect(button.closest(".event-action-strip")?.textContent).toContain("当前状态不支持此操作"));
  expect(fetcher).toHaveBeenCalledWith("/api/v1/tasks/2/controls",expect.objectContaining({body:JSON.stringify({action,expected_state_version:3})}));
});
