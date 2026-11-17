// @vitest-environment jsdom
import React from "react";
import {afterEach, expect, it, vi} from "vitest";
import {cleanup, render, screen} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {CoordinationPanel} from "./CoordinationPanel";
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it("应用关联展示目标依据并保留服务端冲突反馈",async()=>{
 const fetcher=vi.fn(async (_p:string,o:RequestInit)=>new Response(JSON.stringify(o.method==="GET"?[{id:7,data:{status:"pending",request:{event_id:5,target_task_id:2,evidence:"同一问题"}}}]:{detail:"请先暂停目标 Worker 并等待执行退出"}),{status:o.method==="GET"?200:409}));vi.stubGlobal("fetch",fetcher);
 render(<CoordinationPanel sessionId="worker:2" taskId={2}/>);
 await screen.findByText(/事件 5 → 事件 2/);await userEvent.click(screen.getByRole("button",{name:"管理员应用关联 7"}));
 expect((await screen.findByRole("alert")).textContent).toContain("请先暂停");expect(fetcher.mock.calls.some(([p])=>p.endsWith("/coordination/7/apply"))).toBe(true);
});
