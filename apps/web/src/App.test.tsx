// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
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
) {
  const currentTask = { ...task, ...taskOverrides };
  const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
    if (options?.method && options.method !== "GET")
      return write(path, options);
    const responses: Record<string, unknown> = {
      "/health": { status: "ok", version: "test" },
      "/api/v1/projects": [project],
      "/api/v1/tasks": [currentTask],
      "/api/v1/connectors": connectors,
      "/api/v1/identities": [],
      "/api/v1/budgets": [],
      "/api/v1/audit?limit=100": [],
      "/api/v1/overview": { counts: {} },
      "/api/v1/settings": {},
      "/api/v1/auth/me": { role, name: "测试用户" },
      "/api/v1/tasks/2": {
        task: currentTask,
        events: [],
        artifacts: [],
        approvals: [],
      },
    };
    return new Response(JSON.stringify(responses[path] ?? {}));
  });
  vi.stubGlobal("fetch", fetcher);
  render(<App />);
  return fetcher;
}

describe("工作台关键交互", () => {
  it("未知执行结果要求核验证据并携带状态版本对账", async () => {
    const user = userEvent.setup();
    const fetcher = setup(() => new Response("{}"), "admin", [], {
      status: "waiting_resource",
      outcome_unknown: true,
    });
    await user.click(await screen.findByRole("button", { name: /修复导出/ }));
    await screen.findByText("执行结果未知");
    expect(
      (
        screen.getByRole("button", {
          name: "提交执行对账",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await user.selectOptions(
      screen.getByLabelText("执行对账结果"),
      "abandoned",
    );
    await user.type(
      screen.getByLabelText("执行核验证据"),
      "进程已停止，确认保留现有记录并放弃任务",
    );
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

  it("项目改动范围必须明确选择，支持显式不允许修改", async () => {
    const user = userEvent.setup();
    const fetcher = setup(() => new Response("{}"));
    await screen.findByText("测试用户");
    await user.click(screen.getByRole("button", { name: "项目设置" }));
    await user.type(screen.getByLabelText("项目名称"), "分析仓库");
    await user.type(screen.getByLabelText("仓库绝对目录"), "E:/analysis");
    expect(
      (screen.getByLabelText("改动验收范围") as HTMLSelectElement).required,
    ).toBe(true);
    await user.selectOptions(screen.getByLabelText("改动验收范围"), "none");
    await user.click(screen.getByRole("button", { name: "保存项目" }));
    await waitFor(() =>
      expect(fetcher).toHaveBeenCalledWith(
        "/api/v1/projects",
        expect.objectContaining({
          body: expect.stringContaining('"allowed_paths":[]'),
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
    expect(screen.queryByRole("button", { name: "＋ 新建任务" })).toBeNull();
    await user.click(await screen.findByRole("button", { name: /修复导出/ }));
    await screen.findByText("当前目标");
    expect(screen.queryByRole("button", { name: "暂停" })).toBeNull();
    expect(screen.queryByRole("button", { name: "提交要求" })).toBeNull();
  });
  it("新建弹窗支持 Escape 关闭并隔离背景键盘焦点", async () => {
    const user = userEvent.setup();
    setup(() => new Response("{}"));
    await user.click(
      await screen.findByRole("button", { name: "＋ 新建任务" }),
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(document.querySelector("main")?.hasAttribute("inert")).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("创建失败保留目标并展示错误", async () => {
    const user = userEvent.setup();
    const fetcher = setup(() => {
      throw new TypeError("offline");
    });
    await screen.findByText("让每项工作持续向前");
    await user.click(screen.getByRole("button", { name: "＋ 新建任务" }));
    await user.selectOptions(screen.getByLabelText("项目"), "1");
    expect((screen.getByLabelText("任务类型") as HTMLSelectElement).value).toBe(
      "repair",
    );
    await user.selectOptions(screen.getByLabelText("任务类型"), "analysis");
    await user.type(screen.getByLabelText("任务标题"), "新修复");
    await user.type(screen.getByLabelText("目标"), "保留我的目标");
    await user.click(screen.getByRole("button", { name: "创建任务" }));
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
    await user.click(await screen.findByRole("button", { name: /修复导出/ }));
    await user.type(await screen.findByLabelText("要求内容"), "兼容旧字段");
    await user.click(screen.getByRole("button", { name: "提交要求" }));
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

  it("暂停请求成功后等待执行端确认，保持真实运行状态", async () => {
    const user = userEvent.setup();
    setup(() => new Response(JSON.stringify(task)));
    await user.click(await screen.findByRole("button", { name: /修复导出/ }));
    await user.click(await screen.findByRole("button", { name: "暂停" }));
    await screen.findByText("已请求停止 · 等待执行端确认");
    expect(screen.queryByText("已暂停", { exact: true })).toBeNull();
  });
});
