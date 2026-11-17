// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ConversationContent } from "./ConversationContent";
afterEach(cleanup);

it("真实Worker输入按角色显示消息，空附件省略，原始输入折叠", () => {
  render(
    <ConversationContent
      variant="input"
      content={JSON.stringify({
        messages: [
          { role: "user", content: "请整理本周工作" },
          {
            role: "assistant",
            content: [{ type: "text", text: "已整理三个项目" }],
          },
        ],
        attachment_material: [],
      })}
    />,
  );
  expect(screen.getByRole("heading", { name: "用户" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "助手" })).toBeTruthy();
  expect(screen.getByText("请整理本周工作")).toBeTruthy();
  expect(screen.getByText("已整理三个项目")).toBeTruthy();
  expect(screen.queryByText("附件内容")).toBeNull();
  expect(
    screen.queryByText("已保存一份结构化代理报告，可展开原始记录核对。"),
  ).toBeNull();
  expect(screen.getByText("查看原始输入").closest("details")?.open).toBe(false);
});

it("共享摘要空状态及候选事件字段使用中文", () => {
  render(
    <ConversationContent
      content={{
        shared_state: { recent_results: [], subscriptions: [] },
        tasks: [
          {
            id: 2,
            title: "整理工作",
            revision: 3,
            status: "waiting_input",
            input: "新增资料",
            goal: "形成汇总",
          },
        ],
      }}
    />,
  );
  expect(screen.getByText(/近期结果 · 暂无近期结果/)).toBeTruthy();
  expect(screen.getByText(/订阅关系 · 暂无订阅/)).toBeTruthy();
  const task = screen.getByText(/编号 · 2/);
  expect(task.textContent).toContain("事件名称 · 整理工作");
  expect(task.textContent).toContain("目标版本 · 3");
  expect(task.textContent).toContain("状态 · 待补充");
  expect(task.textContent).toContain("输入内容 · 新增资料");
  expect(task.textContent).toContain("事件目标 · 形成汇总");
});

it("真实输入有附件时展示附件正文", () => {
  render(
    <ConversationContent
      variant="input"
      content={{
        messages: [{ role: "user", content: "核对附件" }],
        attachment_material: ["附件的可见正文"],
      }}
    />,
  );
  expect(screen.getByText("附件内容")).toBeTruthy();
  expect(screen.getByText("附件的可见正文")).toBeTruthy();
});
