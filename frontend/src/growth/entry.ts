import { parseGrowthHash } from "./router";
import {
  growthWorkspaceHost,
  resetGrowthRuntime,
  startGrowthRuntime
} from "./runtime";

function renderUnavailable(reason: string): void {
  const host = growthWorkspaceHost();
  if (!host) return;
  host.innerHTML = `<div class="growth-unavailable">
    <p>Growth 真实模式不可用：<code>${reason.replace(/[<>&"]/gu, "")}</code></p>
  </div>`;
}

export function startGrowthWhenRequested(): void {
  const host = growthWorkspaceHost();
  const shells = document.querySelectorAll<HTMLElement>(
    ".replica-shell, .shell"
  );
  let startPromise: Promise<void> | null = null;
  let resetPromise: Promise<void> = Promise.resolve();
  let retryAfterPending = false;

  const syncSurface = () => {
    const growthRequested = parseGrowthHash(window.location.hash) !== null;
    if (host) host.hidden = !growthRequested;
    shells.forEach((shell) => {
      shell.hidden = growthRequested;
    });
    return growthRequested;
  };

  const startRequestedGrowth = () => {
    if (!syncSurface()) return;
    if (startPromise) {
      retryAfterPending = true;
      return;
    }
    let retryableOutcome = true;
    startPromise = startGrowthRuntime()
      .then((mode) => {
        retryableOutcome = mode.kind === "unavailable"
          || mode.kind === "cancelled";
        if (mode.kind === "unavailable") renderUnavailable(mode.reason);
      })
      .catch(() => {
        renderUnavailable("workspace_selection_required");
      })
      .finally(() => {
        startPromise = null;
        if (!retryAfterPending || !retryableOutcome) {
          retryAfterPending = false;
          return;
        }
        retryAfterPending = false;
        startRequestedGrowth();
      });
  };

  startRequestedGrowth();
  window.addEventListener("hashchange", startRequestedGrowth);
  document.addEventListener("goodjob:auth-state-changed", (event) => {
    const detail = (event as CustomEvent<{ authenticated?: boolean }>).detail;
    if (detail?.authenticated === false) {
      retryAfterPending = false;
      resetPromise = resetPromise
        .catch(() => undefined)
        .then(() => resetGrowthRuntime())
        .catch(() => undefined);
      return;
    }
    if (detail?.authenticated) {
      void resetPromise
        .catch(() => undefined)
        .then(startRequestedGrowth);
    }
  });
}
