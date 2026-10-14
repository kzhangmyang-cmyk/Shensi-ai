function guidance(host: HTMLElement): void {
  host.innerHTML = `<section class="douyin-live-login-embedded">
    <p class="douyin-live-login-status" role="status">桌面版使用外部浏览器登录，请返回抖音获客页面。</p>
  </section>`;
}

export async function mountEmbeddedDouyinLiveLogin(
  host: HTMLElement,
  _sessionId: string,
): Promise<() => void> {
  guidance(host);
  return () => host.replaceChildren();
}

export async function startDouyinLiveLoginPage(): Promise<void> {
  const host = document.createElement("div");
  host.id = "douyinLiveLoginRoot";
  document.body.replaceChildren(host);
  guidance(host);
}
