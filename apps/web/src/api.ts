export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function request<T>(
  path: string,
  body?: unknown,
  method = "POST",
  timeoutMs = 15000,
): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      path.startsWith("/health") ? path : `/api/v1${path}`,
      {
        method: body === undefined ? "GET" : method,
        credentials: "same-origin",
        headers:
          body === undefined || body instanceof FormData
            ? undefined
            : { "Content-Type": "application/json" },
        body: body === undefined || body instanceof FormData ? body : JSON.stringify(body),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const detail =
        typeof payload.detail === "string"
          ? payload.detail
          : JSON.stringify(payload.detail ?? "请求失败");
      throw new ApiError(
        response.status,
        response.status === 409
          ? `操作未完成（${detail}）。请刷新后核对最新状态与配置，再重新提交。`
          : detail,
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error(
      "无法连接服务或请求超时。请检查服务后重试，输入内容已保留。",
    );
  } finally {
    window.clearTimeout(timeout);
  }
}

export const statusNames: Record<string, string> = {
  queued: "排队中",
  running: "执行中",
  waiting_input: "待补充",
  waiting_approval: "待审批",
  waiting_resource: "等待资源",
  paused: "已暂停",
  review_ready: "待验收",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

export function isDeliveryApproval(approval: {
  action?: Record<string, unknown>;
}): boolean {
  return (
    ["dingtalk", "redmine"].includes(String(approval.action?.source)) &&
    ["reply", "comment"].includes(String(approval.action?.kind))
  );
}

export function controlLabel(task: {
  status: string;
  stop_requested?: boolean;
  stop_requested_at?: string | null;
  pending_control?: string | null;
  control_action?: string | null;
  stop_confirmed?: boolean;
  last_error?: string | null;
}): string {
  if (
    task.stop_confirmed === false ||
    task.last_error === "正在停止执行" ||
    task.pending_control ||
    task.stop_requested ||
    (task.stop_requested_at && !["paused", "cancelled"].includes(task.status))
  )
    return "已请求停止 · 等待执行端确认";
  return statusNames[task.status] ?? task.status;
}
