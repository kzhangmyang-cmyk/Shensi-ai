import type { GrowthBootstrapResponse } from "./contracts";
import {
  createGrowthHttpClient,
  type GrowthHttpClient
} from "./http";

export interface GrowthBootstrapLoader {
  load(signal?: AbortSignal): Promise<GrowthBootstrapResponse>;
}

export function createGrowthBootstrapLoader(
  client: GrowthHttpClient = createGrowthHttpClient()
): GrowthBootstrapLoader {
  return Object.freeze({
    async load(signal?: AbortSignal) {
      const response = await client.request<GrowthBootstrapResponse>(
        "/api/v1/growth/bootstrap",
        { signal }
      );
      return response.body;
    }
  });
}

export async function loadGrowthBootstrap(
  client: GrowthHttpClient = createGrowthHttpClient(),
  signal?: AbortSignal
): Promise<GrowthBootstrapResponse> {
  return createGrowthBootstrapLoader(client).load(signal);
}
