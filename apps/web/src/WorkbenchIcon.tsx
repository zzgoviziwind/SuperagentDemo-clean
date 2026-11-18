const paths: Record<string, string> = {
  "事件中心": "M5 3h14v18H5z M8 8h8 M8 12h8 M8 16h5",
  "现场记录": "M5 4h14v16H5z M8 8h8 M8 12h5 M8 16h8",
  "Worker 工作台": "M4 5h16v14H4z M7 9l3 3-3 3 M12 15h5",
  "项目设置": "M3 7V5h7l2 2h9v12H3z",
  "事件规则": "M4 6h16 M4 12h16 M4 18h16 M8 4v4 M16 10v4 M10 16v4",
  "管理设置": "M12 3l8 4v5c0 4-3 7-8 9-5-2-8-5-8-9V7z M9 12l2 2 4-4",
  "运行状态": "M3 12h4l3-6 4 12 3-6h4",
  "消息记录": "M4 5h16v11H9l-5 3z M8 9h8 M8 12h5",
  "订阅关系": "M7 6a2 2 0 1 0 0 .01 M17 12a2 2 0 1 0 0 .01 M7 18a2 2 0 1 0 0 .01 M9 7l6 4 M9 17l6-4",
  "分派复核": "M6 3h9l4 4v14H6z M9 13l2 2 5-5",
  "更多工具": "M5 12h.01 M12 12h.01 M19 12h.01",
};

export function WorkbenchIcon({ name }: { name: string }) {
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
    strokeWidth={name === "更多工具" ? 3 : 1.65} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={paths[name]} />
  </svg>;
}
