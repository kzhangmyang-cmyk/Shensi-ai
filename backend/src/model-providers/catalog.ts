import type { ModelProviderId } from "./types.js";

export interface ModelProviderCatalogEntry {
  id: ModelProviderId;
  displayName: string;
  protocol: string;
  modelCatalogVersion: string;
  models: readonly ModelDescriptor[];
}

export interface ModelDescriptor {
  id: string;
  displayName: string;
  ownedBy: string | null;
}

function catalogEntry(
  entry: ModelProviderCatalogEntry
): ModelProviderCatalogEntry {
  return Object.freeze({
    ...entry,
    models: Object.freeze(
      entry.models.map((model) => Object.freeze({ ...model }))
    )
  });
}

export const MODEL_PROVIDER_CATALOG = Object.freeze([
  {
    id: "openai",
    displayName: "OpenAI",
    protocol: "Responses / Chat Completions",
    modelCatalogVersion: "2026-07-23",
    models: Object.freeze([])
  },
  {
    id: "moonshot",
    displayName: "Kimi / Moonshot",
    protocol: "OpenAI-compatible Chat Completions",
    modelCatalogVersion: "2026-07-23",
    models: Object.freeze([])
  },
  {
    id: "minimax",
    displayName: "MiniMax",
    protocol: "MiniMax / OpenAI-compatible Chat Completions",
    modelCatalogVersion: "2026-07-23",
    models: Object.freeze([])
  },
  {
    id: "zhipu",
    displayName: "Zhipu GLM",
    protocol: "OpenAI-compatible Chat Completions",
    modelCatalogVersion: "2026-07-23",
    models: Object.freeze([])
  },
  {
    id: "deepseek",
    displayName: "DeepSeek",
    protocol: "OpenAI-compatible Chat Completions",
    modelCatalogVersion: "2026-07-23",
    models: Object.freeze([])
  },
  {
    id: "qwen",
    displayName: "Alibaba Cloud Model Studio / Qwen",
    protocol: "OpenAI-compatible Chat / Responses",
    modelCatalogVersion: "2026-07-23",
    models: Object.freeze([])
  },
  {
    id: "doubao",
    displayName: "Volcengine Ark / Doubao",
    protocol: "Ark official API",
    modelCatalogVersion: "2026-07-23",
    models: Object.freeze([])
  },
  {
    id: "hunyuan",
    displayName: "Tencent Hunyuan",
    protocol: "OpenAI-compatible Chat Completions",
    modelCatalogVersion: "2026-07-23",
    models: Object.freeze([])
  },
  {
    id: "qianfan",
    displayName: "Baidu Qianfan / ERNIE",
    protocol: "Qianfan official API",
    modelCatalogVersion: "2026-07-23",
    models: Object.freeze([])
  }
].map((entry) => catalogEntry(
  entry as ModelProviderCatalogEntry
)));

export function getModelProviderCatalogEntry(provider: ModelProviderId) {
  return MODEL_PROVIDER_CATALOG.find((entry) => entry.id === provider);
}
