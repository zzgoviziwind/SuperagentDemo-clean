// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EventGroupDiagnostics, EventGroupDetail } from "./EventGroups";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const group = { id:1, title:"报告异常", goal:"核验分页", status:"completed", processing_status:"needs_review", pending_event_count:1, event_count:2, state_version:4 };
it("事件核验携带事件版本和依据，冲突时保留输入", async () => {
  const fetcher = vi.fn(async (_path: string, options?: RequestInit) => options?.method === "POST"
    ? new Response(JSON.stringify({detail:"版本已变化"}), {status:409})
    : new Response(JSON.stringify({group, events:[{id:8, source:"redmine", content:"截图", requires_resolution:true,processing:{status:"pending"}, data:{}}], following:[]})));
  vi.stubGlobal("fetch", fetcher);
  render(<EventGroupDetail id="1" canWrite onOpen={vi.fn()} onSession={vi.fn()} onChanged={vi.fn()} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", {name:"核对此事件"}));
  await user.type(screen.getByLabelText("处理依据"), "报告已核对");
  await user.click(screen.getByRole("button", {name:"确认已解决"}));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("版本已变化"));
  expect((screen.getByLabelText("处理依据") as HTMLTextAreaElement).value).toBe("报告已核对");
  expect(fetcher.mock.calls.some(([p,o]) => p.endsWith("/events/8/resolution") && JSON.parse(String(o?.body)).expected_state_version === 4)).toBe(true);
});

it("运行记录不作为事件展示并默认折叠到末尾", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({group, events:[
    {id:8,source:"redmine",content:"用户报告",requires_resolution:true,processing:{status:"pending"}},
    {id:9,source:"runtime",event_type:"run_started",content:"内部运行",requires_resolution:false,processing:{status:"pending"}},
    {id:10,source:"coordination",event_type:"collaboration_result",content:"内部协作",requires_resolution:true,processing:{status:"pending"}}
  ],following:[]}))));
  render(<><EventGroupDetail id="1" canWrite={false} onOpen={vi.fn()} onSession={vi.fn()} onChanged={vi.fn()} /><EventGroupDiagnostics id="1" /></>);
  await screen.findByText("用户报告");
  expect(screen.queryByText("事件 #9")).toBeNull();
  expect(screen.queryByText("事件 #10")).toBeNull();
  const diagnostics = screen.getByText("处理过程与诊断（2 条记录）").closest("details")!;
  expect(diagnostics.open).toBe(false);
  expect(diagnostics.parentElement?.lastElementChild).toBe(diagnostics);
  expect(screen.getByLabelText("当前处理进度")).toBeTruthy();
});
