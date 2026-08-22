export function csrfFromCookie(cookie: string): string {
  const encoded = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("gj_csrf="))
    ?.slice("gj_csrf=".length);
  if (!encoded) throw new Error("登录会话缺少 CSRF 令牌，请重新登录");
  try {
    const decoded = decodeURIComponent(encoded);
    if (!decoded) throw new Error("empty");
    return decoded;
  } catch {
    throw new Error("CSRF 令牌格式无效，请重新登录");
  }
}
