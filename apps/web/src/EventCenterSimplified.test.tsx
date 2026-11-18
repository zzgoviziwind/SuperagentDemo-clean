// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { EventCenter } from "./EventCenter";
afterEach(() => {cleanup(); vi.unstubAllGlobals();});
it("来源优先、进度一图、诊断默认折叠且完成不冒充发送", async () => {
 const event={id:1,source:"web",content:"检查报告",data:{routing_status:"routed"}};
 const trace={event,attempts:[],subscriptions:[],task:{id:2,status:"completed"},deliveries:[{draft:{content:"已分析"}}],related_events:[{...event,actor_name:"用户"}]};
 vi.stubGlobal("fetch",vi.fn(async (url:string)=>new Response(JSON.stringify(url.includes("/trace")?trace:{items:[event,{id:9,source:"runtime",content:"内部运行标记"}],has_more:false,next_after:1}))));
 render(<EventCenter initialEventId={1} onOpenTask={()=>{}} onManage={()=>{}}/>);
 await screen.findByRole("heading",{name:"处理进度"});
 expect(screen.queryByText("内部运行标记")).toBeNull();
 expect(screen.getByText("处理记录与诊断").closest("details")?.open).toBe(false);
 expect(screen.getByRole("heading",{name:"同事件的来源事件"}).compareDocumentPosition(screen.getByRole("heading",{name:"处理进度"})) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 expect(screen.getByText("已有回复草稿，尚未确认发送")).toBeTruthy();
 expect(screen.queryByRole("navigation",{name:"关联导航"})).toBeNull();
});
