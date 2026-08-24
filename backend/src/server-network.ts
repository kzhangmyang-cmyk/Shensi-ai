const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);
const COMPOSE_INTERNAL_NETWORK_HOST = "0.0.0.0";

export function resolveBackendHost(env: NodeJS.ProcessEnv = process.env) {
  const host = (env.BACKEND_HOST || "127.0.0.1").trim();
  if (!host) throw new Error("BACKEND_HOST 不能为空");
  if (
    env.NODE_ENV === "production"
    && !LOOPBACK_HOSTS.has(host)
    && host !== COMPOSE_INTERNAL_NETWORK_HOST
  ) {
    throw new Error("生产环境后端只能监听回环地址或 Compose 内部网络地址 0.0.0.0");
  }
  return host;
}
