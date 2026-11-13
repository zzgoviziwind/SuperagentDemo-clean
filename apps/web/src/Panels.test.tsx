// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GovernancePanel } from "./GovernancePanel";
import { DeliveriesPanel } from "./DeliveriesPanel";
import { isDeliveryApproval } from "./api";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const changed = async () => {};

it("身份授权仅发送用户明确勾选的项目和请求权限", async () => {
  const fetcher = vi.fn(
    async (_path: string, options?: RequestInit) =>
      new Response(options?.method === "POST" ? "{}" : "[]"),
  );
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  render(
    <GovernancePanel
      settings={{}}
      projects={[
        { id: 1, name: "项目一" },
        { id: 2, name: "项目二" },
      ]}
      onChange={changed}
    />,
  );
  await user.click(screen.getByRole("button", { name: "身份与项目授权" }));
  await user.type(screen.getByLabelText("外部用户 ID"), "external-1");
  await user.type(screen.getByLabelText("系统用户 ID"), "member-1");
  await user.click(screen.getByLabelText("项目二"));
  await user.click(screen.getByLabelText("允许从已授权项目发起请求"));
  await user.click(screen.getByRole("button", { name: "保存身份授权" }));
  await waitFor(() =>
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/identities",
      expect.objectContaining({
        body: '{"source":"dingtalk","actor_id":"external-1","user_id":"member-1","enabled":true,"project_ids":[2],"permissions":["request"]}',
      }),
    ),
  );
});

it("连接器配置保存引用环境变量，保持启用为明确选择", async () => {
  const fetcher = vi.fn(
    async (_path: string, options?: RequestInit) =>
      new Response(options?.method === "PATCH" ? "{}" : "[]"),
  );
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  render(<GovernancePanel settings={{}} projects={[]} onChange={changed} />);
  await user.click(screen.getByRole("button", { name: "连接器配置" }));
  await user.selectOptions(screen.getByLabelText("连接器"), "redmine");
  await user.type(
    screen.getByLabelText("Redmine 服务地址"),
    "https://redmine.example.test",
  );
  await user.type(screen.getByLabelText("Redmine 当前用户 ID"), "8");
  await user.type(screen.getByLabelText("Redmine 项目 ID（每行一项）"), "12");
  await user.type(screen.getByLabelText("API Key 环境变量名称"), "REDMINE_KEY");
  await user.click(screen.getByRole("button", { name: "保存连接器配置" }));
  await waitFor(() =>
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/settings",
      expect.objectContaining({
        method: "PATCH",
        body: expect.stringContaining('"api_key_env":"REDMINE_KEY"'),
      }),
    ),
  );
  const call = fetcher.mock.calls.find(
    ([, options]) => options?.method === "PATCH",
  );
  const config = JSON.parse(call![1]!.body as string)["connectors.redmine"];
  expect(config.enabled).toBe(false);
  expect(config.project_ids).toEqual([12]);
  expect(fetcher.mock.calls.some(([path]) => path.includes("/start"))).toBe(
    false,
  );
});

const approval = {
  id: 10,
  status: "pending",
  action_hash: "hash-10",
  revision: 1,
  action: {
    source: "redmine",
    kind: "comment",
    target: { base_url: "https://redmine.example.test", issue_id: 50 },
  },
};
const draft = {
  id: 3,
  approval_id: 10,
  content: "已完成修复并验证",
  delivery: null,
};

it("回复审批使用 delivery endpoint，批准后发送仍需要确认", async () => {
  const user = userEvent.setup();
  const fetcher = vi.fn(
    async (_path: string, options?: RequestInit) =>
      new Response(options?.method === "POST" ? "{}" : JSON.stringify([draft])),
  );
  vi.stubGlobal("fetch", fetcher);
  const view = render(
    <DeliveriesPanel
      taskId="2"
      events={[]}
      approvals={[approval]}
      canWrite
      onChange={changed}
    />,
  );
  await user.click(await screen.findByRole("button", { name: "批准回复草稿" }));
  await waitFor(() =>
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/deliveries/3/decision",
      expect.objectContaining({
        body: '{"decision":"approve","action_hash":"hash-10"}',
      }),
    ),
  );
  expect(
    fetcher.mock.calls.some(([path]) => path.startsWith("/api/v1/approvals")),
  ).toBe(false);
  view.rerender(
    <DeliveriesPanel
      taskId="2"
      events={[]}
      approvals={[{ ...approval, status: "approved" }]}
      canWrite
      onChange={changed}
    />,
  );
  await user.click(
    await screen.findByRole("button", { name: "发送已批准回复" }),
  );
  expect(fetcher.mock.calls.some(([path]) => path.endsWith("/publish"))).toBe(
    false,
  );
  await user.click(screen.getByRole("button", { name: "确认发送到原渠道" }));
  await waitFor(() =>
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/deliveries/3/publish",
      expect.objectContaining({ method: "POST" }),
    ),
  );
});

it("结果未知时仅提供有证据的对账操作", async () => {
  const user = userEvent.setup();
  const fetcher = vi.fn(
    async (_path: string, options?: RequestInit) =>
      new Response(
        options?.method === "POST"
          ? "{}"
          : JSON.stringify([
              { ...draft, delivery: { write_status: "unknown" } },
            ]),
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  render(
    <DeliveriesPanel
      taskId="2"
      events={[]}
      approvals={[{ ...approval, status: "approved" }]}
      canWrite
      onChange={changed}
    />,
  );
  await screen.findByText("发送结果未知，需要在原渠道核验后对账。");
  expect(screen.queryByRole("button", { name: "发送已批准回复" })).toBeNull();
  expect(
    (screen.getByRole("button", { name: "提交发送对账" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await user.type(
    screen.getByLabelText("核验证据"),
    "原渠道评论编号 100 已确认",
  );
  await user.click(screen.getByRole("button", { name: "提交发送对账" }));
  await waitFor(() =>
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/deliveries/3/reconcile",
      expect.objectContaining({
        body: '{"outcome":"succeeded","evidence":"原渠道评论编号 100 已确认"}',
      }),
    ),
  );
});

it("按实际动作来源与类型区分渠道审批和 Codex 审批", () => {
  expect(isDeliveryApproval(approval)).toBe(true);
  expect(
    isDeliveryApproval({
      action: { method: "item/commandExecution/requestApproval" },
    }),
  ).toBe(false);
});
