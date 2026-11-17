import { afterEach, expect, it, vi } from "vitest";
import type { ProxyOptions, UserConfig } from "vite";

afterEach(() => vi.unstubAllEnvs());

it("开发代理保留请求身份和 Host/Origin，不从环境注入管理员凭据", async () => {
  vi.stubEnv("SUPERAGENT_API_TOKEN", "test-only-admin-token");
  const config = (await import("../vite.config")).default as UserConfig;
  for (const path of ["/api", "/health"]) {
    const proxy = config.server?.proxy?.[path] as ProxyOptions;
    expect(proxy.target).toBe("http://127.0.0.1:8765");
    expect(proxy.changeOrigin).toBe(false);
    expect(proxy.headers).toBeUndefined();
    expect(proxy.configure).toBeUndefined();
    expect(proxy.auth).toBeUndefined();
  }
});
