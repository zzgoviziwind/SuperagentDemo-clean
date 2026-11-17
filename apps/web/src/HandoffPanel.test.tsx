// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HandoffPanel } from "./HandoffPanel";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("一次展开完成暂停和材料准备，收起不重复操作", async () => {
 let paused = false;
 const calls: string[] = [];
 vi.stubGlobal("fetch", vi.fn(async (path: string) => {
   calls.push(path);
   if (path.endsWith("/controls")) paused = true;
   return new Response(JSON.stringify(path.endsWith("/handoff") ? {content:"原 Codex 会话：real-thread"} : {task:{status:paused ? "paused":"running",state_version:2}}));
 }));
 const user = userEvent.setup(); render(<HandoffPanel taskId={1}/>);
 await user.click(screen.getByRole("button",{name:"由我接着做"}));
 await screen.findByDisplayValue("原 Codex 会话：real-thread");
 expect(calls.filter(p=>p.endsWith("/controls"))).toHaveLength(1);
 expect(calls.filter(p=>p.endsWith("/handoff"))).toHaveLength(1);
 await user.click(screen.getByRole("button",{name:"收起接管材料"}));
 expect(screen.queryByLabelText("Codex 接管材料")).toBeNull();
});
