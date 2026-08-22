import {
  BRIDGE_VERSION,
  parseExtensionEvent,
  parsePageCommand,
  type ExtensionEvent
} from "./protocol";
import { goodJobRecoveryTerminalFromMemory } from "./restart-recovery";

declare const chrome: any;

function isAllowedOrigin(origin: string): boolean {
  const scripts = chrome.runtime.getManifest().content_scripts;
  if (!Array.isArray(scripts)) return false;
  return scripts.some((script: unknown) => {
    if (script === null || typeof script !== "object" || Array.isArray(script)) return false;
    const matches = (script as { matches?: unknown }).matches;
    return Array.isArray(matches) && matches.includes(`${origin}/*`);
  });
}

if (typeof chrome !== "undefined" && isAllowedOrigin(globalThis.location.origin)) {
  const origin = globalThis.location.origin;
  let channelNonce: string | null = null;
  let sessionId: string | null = null;

  function emit(event: ExtensionEvent): void {
    const parsed = parseExtensionEvent(event);
    if (!parsed || parsed.channelNonce !== channelNonce) return;
    if (parsed.type !== "ready" && parsed.sessionId !== sessionId) return;
    globalThis.postMessage(parsed, origin);
  }

  globalThis.addEventListener("message", (rawEvent: MessageEvent) => {
    if (rawEvent.source !== window || rawEvent.origin !== origin) return;
    const command = parsePageCommand(rawEvent.data, origin);
    if (!command) return;
    if (command.type === "probe") {
      channelNonce = command.channelNonce;
      sessionId = null;
    } else if (command.channelNonce !== channelNonce) {
      return;
    }
    if (command.type === "start") sessionId = command.sessionId;
    if (command.type !== "probe" && command.sessionId !== sessionId) return;
    void chrome.runtime.sendMessage({
      kind: "goodjob_page_command",
      origin,
      command
    }).then((response: unknown) => {
      if (response === null || typeof response !== "object" || Array.isArray(response)) return;
      const event = (response as { event?: unknown }).event;
      const parsed = parseExtensionEvent(event);
      if (parsed) emit(parsed);
    }).catch(() => undefined);
  });

  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (message === null || typeof message !== "object" || Array.isArray(message)) return;
    const keys = Object.keys(message as Record<string, unknown>);
    const restartTerminal = goodJobRecoveryTerminalFromMemory(message, { channelNonce, sessionId });
    if (restartTerminal) {
      emit(restartTerminal);
      channelNonce = null;
      sessionId = null;
      return;
    }
    if (keys.length !== 2 || !keys.includes("kind") || !keys.includes("event")
      || (message as { kind?: unknown }).kind !== "goodjob_extension_event") return;
    const event = parseExtensionEvent((message as { event?: unknown }).event);
    if (event) emit(event);
  });

  void chrome.runtime.sendMessage({
    kind: "goodjob_bridge_loaded",
    version: BRIDGE_VERSION,
    origin
  }).catch(() => undefined);
}
