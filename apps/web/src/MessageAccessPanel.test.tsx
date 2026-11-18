// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MessageAccessPanel } from "./MessageAccessPanel";
import { GroupScopeFields } from "./GroupScopeFields";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("支持最近发送人、个人候选项目和追问默认项目的持久配置", async () => {
  const fetcher = vi.fn(
    async (url: string) =>
      new Response(
        JSON.stringify(
          url.includes("/events?")
            ? {
                items: [
                  {
                    data: {
                      actor_id: "sender",
                      metadata: { sender_name: "测试同事" },
                    },
                  },
                ],
              }
            : {},
        ),
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  render(
    <MessageAccessPanel
      settings={{}}
      projects={[
        { id: 1, name: "项目甲" },
        { id: 2, name: "通用问答" },
      ]}
      onChange={vi.fn().mockResolvedValue(undefined)}
    />,
  );
  fireEvent.change(screen.getByLabelText("人员回复范围"), {
    target: { value: "selected" },
  });
  await screen.findByRole("option", { name: "测试同事" });
  fireEvent.change(screen.getByLabelText("从待确认消息添加发送人"), {
    target: { value: "sender" },
  });
  fireEvent.change(screen.getByLabelText("是否回复"), {
    target: { value: "off" },
  });
  fireEvent.change(screen.getByLabelText("无法识别所属项目时"), {
    target: { value: "ask" },
  });
  fireEvent.change(screen.getByLabelText("承接追问或未识别消息的默认项目"), {
    target: { value: "2" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存人员与项目规则" }));
  await waitFor(() =>
    expect(fetcher.mock.calls.some(([url]) => url.endsWith("/settings"))).toBe(
      true,
    ),
  );
  const call = fetcher.mock.calls.find(([url]) =>
    url.endsWith("/settings"),
  ) as any;
  const saved = JSON.parse(call[1].body).dingtalk_request_access;
  expect(saved.mode).toBe("selected");
  expect(saved.people[0].reply).toBe(false);
  expect(saved.default_project_id).toBe(2);
  expect(saved.on_unmatched).toBe("ask");
});

it("全部群保留已配置内容并置灰，按名称搜索后显式选择添加", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            items: [{ id: "cid-two", name: "研发协作群" }],
            complete: true,
          }),
        ),
    ),
  );
  const change = vi.fn();
  const view = render(
    <GroupScopeFields
      scope="all"
      ids={["cid-one"]}
      names={{ "cid-one": "医院项目群" }}
      onChange={change}
    />,
  );
  expect(
    (
      screen.getByRole("group", {
        name: "已配置的指定群",
      }) as HTMLFieldSetElement
    ).disabled,
  ).toBe(true);
  expect(screen.getByText("医院项目群")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("群接收范围"), {
    target: { value: "selected" },
  });
  expect(change).toHaveBeenCalledWith("selected", ["cid-one"], {
    "cid-one": "医院项目群",
  }, {});
  view.rerender(
    <GroupScopeFields
      scope="selected"
      ids={["cid-one"]}
      names={{ "cid-one": "医院项目群" }}
      onChange={change}
    />,
  );
  expect(screen.queryByLabelText("按钉钉群名称查找")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "＋ 添加指定群" }));
  fireEvent.change(screen.getByLabelText("按钉钉群名称查找"), {
    target: { value: "研发" },
  });
  fireEvent.click(screen.getByRole("button", { name: "查找群" }));
  const addButton = await screen.findByRole("button", { name: "添加此群" });
  const remark = screen.getByLabelText("群备注（研发协作群）") as HTMLInputElement;
  expect(remark.value).toBe("研发协作群");
  fireEvent.change(remark, { target: { value: "研发工作群备注" } });
  fireEvent.click(addButton);
  expect(change).toHaveBeenLastCalledWith("selected", ["cid-one", "cid-two"], {
    "cid-one": "医院项目群",
    "cid-two": "研发工作群备注",
  }, { "cid-two": "研发协作群" });
});

it("群搜索逐页加载并复用近期结果，清空备注时使用钉钉群名", async () => {
  const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(
    url.includes("cursor=")
      ? { items: [{ id: "b", name: "研发乙群" }], complete: true, has_more: false }
      : { items: [{ id: "a", name: "研发甲群" }], complete: false, has_more: true, next_cursor: "next-page" },
  )));
  vi.stubGlobal("fetch", fetcher);
  const change = vi.fn();
  render(<GroupScopeFields scope="selected" ids={[]} names={{}} onChange={change} />);
  fireEvent.click(screen.getByRole("button", { name: "＋ 添加指定群" }));
  fireEvent.change(screen.getByLabelText("按钉钉群名称查找"), { target: { value: "研发" } });
  fireEvent.click(screen.getByRole("button", { name: "查找群" }));
  fireEvent.click(await screen.findByRole("button", { name: "加载更多群" }));
  await screen.findByText("研发乙群");
  expect(screen.getByText("研发甲群")).toBeTruthy();
  expect(fetcher.mock.calls[1][0]).toContain("&cursor=next-page");
  fireEvent.change(screen.getByLabelText("群备注（研发甲群）"), { target: { value: "  " } });
  fireEvent.click(screen.getAllByRole("button", { name: "添加此群" })[0]);
  expect(change).toHaveBeenLastCalledWith("selected", ["a"], { a: "研发甲群" }, { a: "研发甲群" });
  fireEvent.click(screen.getByRole("button", { name: "查找群" }));
  await screen.findByRole("button", { name: "加载更多群" });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("修改搜索词后忽略旧查询结果", async () => {
  let finish!: (value: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
  render(<GroupScopeFields scope="selected" ids={[]} names={{}} onChange={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "＋ 添加指定群" }));
  const query = screen.getByLabelText("按钉钉群名称查找");
  fireEvent.change(query, { target: { value: "旧词" } });
  fireEvent.click(screen.getByRole("button", { name: "查找群" }));
  fireEvent.change(query, { target: { value: "新词" } });
  finish(new Response(JSON.stringify({ items: [{ id: "old", name: "旧群" }], complete: true })));
  await waitFor(() => expect((screen.getByRole("button", { name: "查找群" }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.queryByText("旧群")).toBeNull();
});

it("已有群补取钉钉原名，编辑备注保留原名", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    id: "old-group", name: "钉钉真实群名",
  }))));
  const change = vi.fn();
  const resolved = vi.fn();
  render(<GroupScopeFields scope="selected" ids={["old-group"]}
    names={{ "old-group": "医院备注" }} onOriginalName={resolved} onChange={change} />);
  await screen.findByText("群原名：钉钉真实群名");
  expect(resolved).toHaveBeenCalledWith("old-group", "钉钉真实群名");
  fireEvent.click(screen.getByText("医院备注"));
  const original = screen.getByLabelText("钉钉群原名") as HTMLInputElement;
  expect(original.value).toBe("钉钉真实群名");
  expect(original.readOnly).toBe(true);
  fireEvent.change(screen.getByLabelText("群备注"), { target: { value: "新备注" } });
  expect(change).toHaveBeenLastCalledWith("selected", ["old-group"],
    { "old-group": "新备注" }, { "old-group": "钉钉真实群名" });
});
