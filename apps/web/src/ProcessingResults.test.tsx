// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ProcessingResults } from "./ProcessingResults";

afterEach(cleanup);

it("默认只展示当前目标的最新结论，过程和历史按来源步骤折叠", () => {
  render(<ProcessingResults group={{ id: 7, revision: 2 }} events={[
    { data: { artifact_id: 1, turn_id: "turn-a" } },
  ]} artifacts={[
    { id: 9, revision: 1, kind: "summary", content: "旧目标的报告" },
    { id: 3, revision: 2, kind: "summary", content: "最终答复" },
    { id: 1, revision: 2, kind: "summary", content: "正在分析" },
    { id: 4, revision: 2, kind: "verification", content: JSON.stringify({ kind: "reply", turn_status: "completed", draft_created: true }) },
  ]} />);
  expect(screen.getByText("最终答复").closest("details")).toBeNull();
  expect(screen.getByText("正在分析").closest("details")?.open).toBe(false);
  expect(screen.getByText("旧目标的报告").closest("details")?.open).toBe(false);
  expect(screen.getByText(/执行轮次 turn-a/)).toBeTruthy();
  expect(screen.getByText(/最近一次系统评估 · 回复生成已完成/)).toBeTruthy();
  expect(screen.queryByRole("link")).toBeNull();
});

it("历史核验不会充当当前目标的核验，无法解析的记录明确提示", () => {
  const view = render(<ProcessingResults group={{ id: 7, revision: 2 }} events={[]} artifacts={[
    { id: 1, revision: 1, kind: "verification", content: "{}" },
  ]} />);
  expect(screen.getByText("当前目标尚无核验记录。")).toBeTruthy();
  view.rerender(<ProcessingResults group={{ id: 7, revision: 2 }} events={[]} artifacts={[
    { id: 2, revision: 2, kind: "verification", content: "invalid" },
  ]} />);
  expect(screen.getByText(/最近一次系统评估 · 核验记录无法解析/)).toBeTruthy();
});
