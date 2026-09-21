import type { GrowthAdvisorTodayResponse } from "../contracts";
import type { components } from "../../generated/growth-advisor-quote-roi";

type RoiSlice =
  components["schemas"]["AdvisorTodayResponse_AdvisorRoiSliceView"];
type PriorityCustomer =
  components["schemas"]["AdvisorTodayResponse_PriorityCustomerView"];
type PendingApproval =
  components["schemas"]["AdvisorTodayResponse_PendingQuoteApprovalView"];
type Gap = components["schemas"]["AdvisorTodayResponse_FinancialDataGapView"];

const expectedRoi: RoiSlice[] = [];
const actualRoi: RoiSlice[] = [];
const priorityCustomers: PriorityCustomer[] = [];
const pendingQuoteApprovals: PendingApproval[] = [];
const financialDataGaps: Gap[] = [];
const recommendations: never[] = [];

export interface GrowthDemoFixture {
  readonly today: GrowthAdvisorTodayResponse;
}

export function createGrowthDemoFixture(): GrowthDemoFixture {
  const today: GrowthAdvisorTodayResponse = {
    workspaceId: "demo-workspace",
    audienceRole: "manager",
    dataAsOf: "2026-08-09T08:00:00.000Z",
    priorityCustomers,
    pendingQuoteApprovals,
    expectedRoi,
    actualRoi,
    financialDataGaps,
    recommendations,
    sourceSnapshotHash: `sha256:${"d".repeat(64)}`
  };
  return Object.freeze({ today });
}
