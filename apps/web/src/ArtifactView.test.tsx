// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ArtifactView } from "./ArtifactView";

afterEach(cleanup);

it("摘要显示可读 summary 和目标版本", () => {
  render(
    <ArtifactView
      revision={2}
      artifact={{
        id: 7,
        revision: 2,
        kind: "summary",
        content: '{"status":"completed","summary":"定位到缺失索引"}',
      }}
    />,
  );
  expect(screen.getByText("定位到缺失索引")).toBeTruthy();
  expect(screen.getByText(/当前版本/)).toBeTruthy();
  expect(
    screen
      .getByRole("link", { name: "下载完整产物 JSON" })
      .getAttribute("href"),
  ).toBe("/api/v1/artifacts/7/download");
});

it("改动展示 diff 与新增文件信息，base64 保留在完整下载中", () => {
  const secretBody = "c2FtcGxlLWJhc2U2NC1ib2R5";
  render(
    <ArtifactView
      revision={2}
      artifact={{
        id: 8,
        revision: 1,
        kind: "changes",
        content: JSON.stringify({
          stat: "1 file changed",
          diff: "+ fixed",
          untracked_artifacts: [
            { path: "new.py", size: 18, content_base64: secretBody },
          ],
        }),
      }}
    />,
  );
  expect(screen.getByText("1 file changed")).toBeTruthy();
  expect(screen.getByText("+ fixed")).toBeTruthy();
  expect(screen.getByText("new.py")).toBeTruthy();
  expect(screen.getByText(/18 字节/)).toBeTruthy();
  expect(screen.getByText(/历史版本/)).toBeTruthy();
  expect(screen.queryByText(secretBody)).toBeNull();
});

it("验证展示命令退出码和失败，完整证据缺失保持未验证", () => {
  render(
    <ArtifactView
      revision={1}
      artifact={{
        id: 9,
        revision: 1,
        kind: "verification",
        content: JSON.stringify({
          tests_executed: false,
          command: "pytest -q",
          exit_code: 1,
          stream_incomplete: true,
          tool_failures: [{ status: "failed", exit_code: 1 }],
          tool_evidence: [
            {
              command: "pytest -q",
              exit_code: 1,
              status: "failed",
              output: "assertion failed",
            },
          ],
          collector_verification: { status: "unverified", evidence: null },
        }),
      }}
    />,
  );
  expect(screen.getByText("验证未通过或尚未完整验证")).toBeTruthy();
  expect(screen.getByText("pytest -q")).toBeTruthy();
  expect(screen.getByText("未确认执行")).toBeTruthy();
  expect(screen.getByText("不完整，仍需核验")).toBeTruthy();
  expect(screen.getByText(/退出码 1 · failed/)).toBeTruthy();
  expect(screen.getByText("assertion failed")).toBeTruthy();
});

it("只读分析采用后端评估和读取证据，展示限制且不要求测试命令", () => {
  const data = {
    tests_executed: false,
    exit_code: null,
    has_changes: false,
    stream_incomplete: false,
    assessment: {
      task_kind: "analysis",
      suggested_status: "review_ready",
      blocking_tool_failures: [],
      tool_failures: [],
      verification: { status: "passed", evidence: { readonly_tool_calls: 4 } },
      outcome: { limitations: ["尚未覆盖生产环境"] },
    },
    analysis_read_evidence: {
      successful_calls: 4,
      evidence_calls: 2,
      file_count: 3,
      tools: ["read_file", "search_text"],
      denied_access: false,
      unresolved_errors: 0,
      unreadable_files: 0,
      truncated_results: 1,
    },
  };
  const view = render(
    <ArtifactView
      revision={1}
      artifact={{
        id: 10,
        revision: 1,
        kind: "verification",
        content: JSON.stringify(data),
      }}
    />,
  );
  expect(screen.getByText("只读分析证据通过")).toBeTruthy();
  expect(screen.getByText("read_file、search_text")).toBeTruthy();
  expect(screen.getByText("读取文件数").nextElementSibling?.textContent).toBe(
    "3",
  );
  expect(screen.getByText("尚未覆盖生产环境")).toBeTruthy();
  expect(screen.queryByText("测试命令")).toBeNull();
  view.rerender(
    <ArtifactView
      revision={1}
      artifact={{
        id: 10,
        revision: 1,
        kind: "verification",
        content: JSON.stringify({ ...data, has_changes: true }),
      }}
    />,
  );
  expect(screen.getByText("验证未通过或尚未完整验证")).toBeTruthy();
});

it("修复采用后端 repair_verified，恢复过的失败保留历史且不会误报阻塞", () => {
  const failure = { kind: "commandExecution", exit_code: 1, recovered: true };
  const data = {
    repair_verified: true,
    tests_executed: true,
    command: "pytest -q",
    exit_code: 0,
    stream_incomplete: false,
    tool_failures: [{ type: "commandExecution", exit_code: 1 }],
    collector_verification: {
      status: "passed",
      evidence: { command_item_ids: ["rerun-1"] },
    },
    assessment: {
      task_kind: "fix",
      suggested_status: "review_ready",
      blocking_tool_failures: [],
      tool_failures: [failure],
    },
  };
  const view = render(
    <ArtifactView
      revision={1}
      artifact={{
        id: 11,
        revision: 1,
        kind: "verification",
        content: JSON.stringify(data),
      }}
    />,
  );
  expect(screen.getByText("验证证据通过")).toBeTruthy();
  expect(screen.getByText("历史失败 · 已恢复")).toBeTruthy();
  expect(screen.getByText("阻塞失败数").nextElementSibling?.textContent).toBe(
    "0",
  );
  view.rerender(
    <ArtifactView
      revision={1}
      artifact={{
        id: 11,
        revision: 1,
        kind: "verification",
        content: JSON.stringify({
          ...data,
          assessment: {
            ...data.assessment,
            blocking_tool_failures: [{ ...failure, recovered: false }],
          },
        }),
      }}
    />,
  );
  expect(screen.getByText("验证未通过或尚未完整验证")).toBeTruthy();
});
