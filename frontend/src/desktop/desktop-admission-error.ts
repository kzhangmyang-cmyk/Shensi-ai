/** Stable server rejections which another login poll cannot repair. */
export function desktopAdmissionMessage(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const code = "code" in error ? error.code : error.message;
  if (code === "desktop_client_build_not_admitted") {
    return "应用版本与后台允许的版本不一致，请同步更新并重新启动应用和后台；重复扫码无法解决。";
  }
  if (code === "desktop_client_migration_locked") {
    return "后台暂未开放桌面连接，请联系管理员完成服务启用后重试。";
  }
  return null;
}
