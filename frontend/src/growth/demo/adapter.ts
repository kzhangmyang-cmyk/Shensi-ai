import type { GrowthAdvisorTodayResponse } from "../contracts";
import { createGrowthDemoFixture } from "./fixture";

export interface GrowthDemoAdapter {
  readonly kind: "demo";
  getToday(): Promise<GrowthAdvisorTodayResponse>;
}

export function createGrowthDemoAdapter(
  fixture = createGrowthDemoFixture()
): GrowthDemoAdapter {
  return Object.freeze({
    kind: "demo",
    async getToday() {
      return fixture.today;
    }
  });
}
