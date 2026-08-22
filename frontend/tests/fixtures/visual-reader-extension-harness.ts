import type { Page } from "@playwright/test";
import type { VisualObservationSubmission } from "../../src/acquisition/visual-reader-api";

const BRIDGE_VERSION = "goodjob.visual-reader.bridge.v1";
const HARNESS_KEY = "__GOODJOB_VISUAL_READER_E2E_HARNESS__";

type RecordedPageCommand = {
  type: "probe" | "start" | "acknowledge_batch" | "abort";
  sessionId: string | null;
  batchId: string | null;
  artifactUploadEnabled: boolean | null;
};

type ExtensionHarnessState = {
  available: boolean;
  channelNonce: string | null;
  sessionId: string | null;
  commands: RecordedPageCommand[];
};

export interface VisualReaderExtensionHarness {
  setAvailable(available: boolean): Promise<void>;
  emitObservationBatch(
    batchId: string,
    observations: VisualObservationSubmission[],
    overrides?: { channelNonce?: string; sessionId?: string }
  ): Promise<void>;
  emitTerminal(
    status: "completed" | "partial_success" | "aborted",
    errorCodes: string[]
  ): Promise<void>;
  emitRaw(event: Record<string, unknown>): Promise<void>;
  commands(): Promise<RecordedPageCommand[]>;
}

declare global {
  interface Window {
    __GOODJOB_VISUAL_READER_E2E_HARNESS__?: ExtensionHarnessState;
  }
}

export async function installVisualReaderExtensionHarness(
  page: Page,
  options: { available?: boolean } = {}
): Promise<VisualReaderExtensionHarness> {
  await page.addInitScript(({ available, bridgeVersion, harnessKey }) => {
    const exactKeys = (value: unknown, keys: string[]): value is Record<string, unknown> => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
      const actual = Object.keys(value as Record<string, unknown>);
      return actual.length === keys.length
        && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
    };
    const state: ExtensionHarnessState = {
      available,
      channelNonce: null,
      sessionId: null,
      commands: []
    };
    Object.defineProperty(window, harnessKey, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: state
    });
    window.addEventListener("message", (rawEvent) => {
      if (rawEvent.source !== window || rawEvent.origin !== window.location.origin) return;
      const value = rawEvent.data;
      if (value === null || typeof value !== "object" || Array.isArray(value)) return;
      const message = value as Record<string, unknown>;
      if (message.version !== bridgeVersion || typeof message.type !== "string"
        || typeof message.channelNonce !== "string") return;
      if (message.type === "probe"
        && exactKeys(message, ["version", "type", "channelNonce"])) {
        state.channelNonce = message.channelNonce;
        state.sessionId = null;
        state.commands.push({
          type: "probe",
          sessionId: null,
          batchId: null,
          artifactUploadEnabled: null
        });
        if (state.available) {
          queueMicrotask(() => window.postMessage({
            version: bridgeVersion,
            type: "ready",
            channelNonce: state.channelNonce,
            extensionVersion: "goodjob-visual-reader/e2e"
          }, window.location.origin));
        }
        return;
      }
      if (message.channelNonce !== state.channelNonce) return;
      if (message.type === "start"
        && exactKeys(message, [
          "version", "type", "channelNonce", "sessionId", "limits",
          "artifactUploadEnabled"
        ])
        && typeof message.sessionId === "string"
        && typeof message.artifactUploadEnabled === "boolean") {
        state.sessionId = message.sessionId;
        state.commands.push({
          type: "start",
          sessionId: message.sessionId,
          batchId: null,
          artifactUploadEnabled: message.artifactUploadEnabled
        });
        return;
      }
      if (message.type === "acknowledge_batch"
        && exactKeys(message, [
          "version", "type", "channelNonce", "sessionId", "batchId"
        ])
        && message.sessionId === state.sessionId
        && typeof message.batchId === "string") {
        state.commands.push({
          type: "acknowledge_batch",
          sessionId: state.sessionId,
          batchId: message.batchId,
          artifactUploadEnabled: null
        });
        return;
      }
      if (message.type === "abort"
        && exactKeys(message, ["version", "type", "channelNonce", "sessionId"])
        && message.sessionId === state.sessionId) {
        state.commands.push({
          type: "abort",
          sessionId: state.sessionId,
          batchId: null,
          artifactUploadEnabled: null
        });
      }
    });
  }, {
    available: options.available !== false,
    bridgeVersion: BRIDGE_VERSION,
    harnessKey: HARNESS_KEY
  });

  async function emit(event: Record<string, unknown>): Promise<void> {
    await page.evaluate(({ event, bridgeVersion, harnessKey }) => {
      const state = window[harnessKey as typeof HARNESS_KEY];
      if (!state) throw new Error("visual reader E2E harness is unavailable");
      window.postMessage({ version: bridgeVersion, ...event }, window.location.origin);
    }, { event, bridgeVersion: BRIDGE_VERSION, harnessKey: HARNESS_KEY });
  }

  return {
    async setAvailable(available) {
      await page.evaluate(({ available, harnessKey }) => {
        const state = window[harnessKey as typeof HARNESS_KEY];
        if (!state) throw new Error("visual reader E2E harness is unavailable");
        state.available = available;
      }, { available, harnessKey: HARNESS_KEY });
    },
    async emitObservationBatch(batchId, observations, overrides = {}) {
      const binding = await page.evaluate((harnessKey) => {
        const state = window[harnessKey as typeof HARNESS_KEY];
        return { channelNonce: state?.channelNonce, sessionId: state?.sessionId };
      }, HARNESS_KEY);
      await emit({
        type: "observation_batch",
        channelNonce: overrides.channelNonce ?? binding.channelNonce,
        sessionId: overrides.sessionId ?? binding.sessionId,
        batchId,
        observations
      });
    },
    async emitTerminal(status, errorCodes) {
      const binding = await page.evaluate((harnessKey) => {
        const state = window[harnessKey as typeof HARNESS_KEY];
        return { channelNonce: state?.channelNonce, sessionId: state?.sessionId };
      }, HARNESS_KEY);
      await emit({
        type: "terminal",
        channelNonce: binding.channelNonce,
        sessionId: binding.sessionId,
        status,
        errorCodes
      });
    },
    emitRaw: emit,
    commands() {
      return page.evaluate((harnessKey) => {
        const state = window[harnessKey as typeof HARNESS_KEY];
        return state ? structuredClone(state.commands) : [];
      }, HARNESS_KEY);
    }
  };
}
