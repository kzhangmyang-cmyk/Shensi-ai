interface ProxyRequest {
  setHeader(name: string, value: string): void;
}

interface ProxyServer {
  on(event: "proxyReq", listener: (request: ProxyRequest) => void): void;
}

interface ProxyIncomingRequest {
  url?: string;
  headers: Record<string, string | string[] | undefined>;
}

interface ProxyResponse {
  statusCode: number;
  writableEnded: boolean;
  end(body?: string): void;
}

export interface DesktopDevApiProxy {
  target: string;
  changeOrigin: true;
  secure: boolean;
  bypass(request: ProxyIncomingRequest, response: ProxyResponse): string | undefined;
  configure(proxy: ProxyServer): void;
}

function parseTargetOrigin(value: string): URL {
  const target = new URL(value);
  if (!(target.protocol === "https:"
    || (target.protocol === "http:" && target.hostname === "127.0.0.1" && target.port !== ""))
    || target.origin !== value) {
    throw new Error("VITE_API_TARGET must be an exact HTTPS or loopback HTTP origin");
  }
  return target;
}

function parseRendererOrigin(value: string): URL {
  const origin = new URL(value);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1"
    || origin.port === "" || origin.origin !== value) {
    throw new Error("desktop dev renderer must be an exact loopback HTTP origin");
  }
  return origin;
}

function trustedRequest(request: ProxyIncomingRequest, renderer: URL): boolean {
  if (request.headers.host !== renderer.host) return false;
  for (const name of ["origin", "referer", "sec-fetch-site"] as const) {
    if (Array.isArray(request.headers[name])) return false;
  }
  const origin = request.headers.origin;
  if (origin !== undefined && (typeof origin !== "string" || origin !== renderer.origin)) return false;
  const referer = request.headers.referer;
  if (referer !== undefined) {
    if (typeof referer !== "string") return false;
    try {
      if (new URL(referer).origin !== renderer.origin) return false;
    } catch {
      return false;
    }
  }
  return request.headers["sec-fetch-site"] !== "cross-site";
}

export function createDesktopDevApiProxy(
  targetValue: string,
  rendererOriginValue: string,
): DesktopDevApiProxy {
  const target = parseTargetOrigin(targetValue);
  const renderer = parseRendererOrigin(rendererOriginValue);
  const origin = target.origin;
  return {
    target: origin,
    changeOrigin: true,
    secure: target.protocol === "https:",
    bypass(request, response) {
      if (trustedRequest(request, renderer)) return undefined;
      response.statusCode = 403;
      response.end("Forbidden");
      return request.url ?? "/api";
    },
    configure(proxy) {
      proxy.on("proxyReq", (request) => {
        request.setHeader("origin", origin);
        request.setHeader("referer", `${origin}/`);
      });
    }
  };
}
