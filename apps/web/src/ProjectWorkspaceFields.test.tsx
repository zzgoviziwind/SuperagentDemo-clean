// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectWorkspaceFields } from "./ProjectWorkspaceFields";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("打开已有项目自动加载完整分支，切换目录后清除旧分支", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = new URL(url, "http://localhost").searchParams.get("path");
      const branches =
        path === "D:/one/web"
          ? ["backup", "智能主检-dev-integrate"]
          : ["second-main"];
      return new Response(JSON.stringify({ items: [], branches }));
    }),
  );
  const props = {
    repositories: [{ path: "web", base_branch: "backup" }],
    onChange: vi.fn(),
  };
  const view = render(<ProjectWorkspaceFields path="D:/one" {...props} />);
  const selector = screen.getByRole("combobox", { name: "web 基线分支" });
  await within(selector).findByRole("option", {
    name: "智能主检-dev-integrate",
  });
  await userEvent.setup().selectOptions(selector, "智能主检-dev-integrate");
  expect(props.onChange).toHaveBeenCalledWith("D:/one", [
    { path: "web", base_branch: "智能主检-dev-integrate" },
  ]);
  view.rerender(<ProjectWorkspaceFields path="D:/two" {...props} />);
  await within(selector).findByRole("option", { name: "second-main" });
  expect(
    within(selector).queryByRole("option", { name: "智能主检-dev-integrate" }),
  ).toBeNull();
});

it("扫描包含接口目录下的嵌套仓库", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = new URL(url, "http://localhost").searchParams.get("path");
      const body =
        path === "D:/guanggu"
          ? {
              directories: [],
              repositories: [
                { name: "interface/hjk", path: "D:/guanggu/interface/hjk" },
              ],
              repositories_complete: true,
            }
          : { branches: ["interface-main"], current_branch: "interface-main" };
      return new Response(JSON.stringify(body));
    }),
  );
  const onChange = vi.fn();
  render(
    <ProjectWorkspaceFields
      path="D:/guanggu"
      repositories={[]}
      onChange={onChange}
    />,
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "识别目录下的仓库" }));
  expect(onChange).toHaveBeenCalledWith("D:/guanggu", [
    { path: "interface/hjk", base_branch: "interface-main" },
  ]);
});

it("通过系统窗口选择目录并清空旧仓库配置", async () => {
  const fetcher = vi.fn(
    async (url: string) =>
      new Response(
        JSON.stringify(
          url.endsWith("/select-directory")
            ? { path: "D:/新的项目" }
            : { items: [], branches: [] },
        ),
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  const onChange = vi.fn();
  render(
    <ProjectWorkspaceFields
      path="D:/old"
      repositories={[]}
      onChange={onChange}
    />,
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "选择项目目录" }));
  expect(fetcher).toHaveBeenCalledWith(
    "/api/v1/project-workspace/select-directory",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ path: "D:/old" }),
    }),
  );
  expect(onChange).toHaveBeenCalledWith("D:/新的项目", []);
});

it("取消系统窗口保留已有目录", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.endsWith("/select-directory")
              ? { path: null }
              : { items: [], branches: [] },
          ),
        ),
    ),
  );
  const onChange = vi.fn();
  render(
    <ProjectWorkspaceFields
      path="D:/old"
      repositories={[]}
      onChange={onChange}
    />,
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "选择项目目录" }));
  expect(onChange).not.toHaveBeenCalled();
  expect(
    screen
      .getByRole("button", { name: "选择项目目录" })
      .hasAttribute("disabled"),
  ).toBe(false);
});

it("系统窗口不可用时提供网页浏览入口", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("/select-directory")
        ? new Response(JSON.stringify({ detail: "请从本机访问" }), {
            status: 501,
          })
        : new Response(JSON.stringify({ items: [], branches: [] })),
    ),
  );
  render(
    <ProjectWorkspaceFields
      path="D:/old"
      repositories={[]}
      onChange={vi.fn()}
    />,
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "选择项目目录" }));
  expect(
    await screen.findByRole("button", { name: "网页浏览目录" }),
  ).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toBe("请从本机访问");
});
