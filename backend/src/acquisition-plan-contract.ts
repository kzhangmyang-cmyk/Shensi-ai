import { z } from "zod";

export const requiredText = (max: number) =>
  z.string().trim().min(1).max(max);

export const idSchema = requiredText(255);

export const acquisitionTargetPlatformSchema = z.enum(["douyin", "web"]);

export const douyinPublicCommentSamplePolicySchema = z.object({
  enabled: z.boolean(),
  maxVideosPerRun: z.number().int().min(1).max(20),
  maxCommentsPerVideo: z.number().int().min(1).max(100),
  maxPagesPerVideo: z.number().int().min(1).max(5)
}).strict();

export const acquisitionUsageSchema = z.object({
  requests: z.number().int().nonnegative(),
  results: z.number().int().nonnegative(),
  amountMinor: z.number().int().nonnegative(),
  durationSeconds: z.number().int().nonnegative()
}).strict();

export const acquisitionBudgetSchema = z.object({
  billingCurrency: z.string().trim().length(3),
  maxRequests: z.number().int().nonnegative(),
  maxResults: z.number().int().nonnegative(),
  maxAmountMinor: z.number().int().nonnegative(),
  maxDurationSeconds: z.number().int().nonnegative()
}).strict();

export const acquisitionProviderConnectionSchema = z.object({
  connectionId: idSchema,
  providerId: requiredText(100),
  kind: z.enum(["search", "content_fetch", "import"]),
  status: z.enum(["active", "inactive", "disabled"]),
  credentialVersion: z.number().int().positive()
}).strict();

export const acquisitionPlanOperationSchema = z.object({
  operationId: idSchema,
  subjectChannel: z.enum(["organization", "individual"]),
  kind: z.enum(["search", "content_fetch", "import_rows"]),
  connectionId: idSchema,
  query: z.string().trim().min(1).max(4_000).optional(),
  sourceRef: z.string().trim().min(1).max(4_000).optional(),
  allocatedBudget: acquisitionUsageSchema
}).strict();

export const acquisitionModelSnapshotSchema = z.object({
  jobSnapshotId: idSchema,
  connectionId: idSchema,
  credentialVersion: z.number().int().positive(),
  provider: requiredText(100),
  model: requiredText(200),
  capabilitySnapshotHash: requiredText(200),
  promptVersion: requiredText(100),
  schemaVersion: requiredText(100),
  promptHash: requiredText(200),
  schemaHash: requiredText(200)
}).strict();

export const acquisitionPlanPayloadSchema = z.object({
  targetPlatform: acquisitionTargetPlatformSchema.optional(),
  douyinPublicCommentSample:
    douyinPublicCommentSamplePolicySchema.optional(),
  name: requiredText(200),
  objective: requiredText(2_000),
  icp: z.object({
    industries: z.array(requiredText(120)).min(1).max(100),
    regions: z.array(requiredText(120)).min(1).max(100),
    organizationCriteria: z.array(requiredText(500)).min(1).max(100),
    individualCriteria: z.array(requiredText(500)).min(1).max(100),
    exclusionRules: z.array(requiredText(500)).max(200)
  }).strict(),
  subjectChannels: z.object({
    organization: z.boolean(),
    individual: z.boolean()
  }).strict(),
  providerConnections:
    z.array(acquisitionProviderConnectionSchema).min(1).max(100),
  operations: z.array(acquisitionPlanOperationSchema).min(1).max(500),
  budgetSnapshot: acquisitionBudgetSchema,
  modelSnapshotRef: acquisitionModelSnapshotSchema,
  stopConditions: z.object({
    stopWhenBudgetExhausted: z.boolean(),
    stopWhenNoMoreResults: z.boolean()
  }).strict()
}).strict();

type DouyinPublicCommentSampleBinding = Pick<
  z.infer<typeof acquisitionPlanPayloadSchema>,
  "targetPlatform" | "douyinPublicCommentSample" | "providerConnections"
>;

function refineDouyinPublicCommentSampleBinding(
  value: DouyinPublicCommentSampleBinding,
  context: z.RefinementCtx
) {
  if (
    value.douyinPublicCommentSample?.enabled
    && value.targetPlatform !== "douyin"
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["douyinPublicCommentSample", "enabled"],
      message: "公开评论样本只能在抖音计划中启用"
    });
  }
  if (
    value.douyinPublicCommentSample?.enabled
    && !value.providerConnections.some((connection) =>
      connection.providerId === "experimental_public_sample"
      && connection.kind === "content_fetch"
      && connection.status === "active"
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["providerConnections"],
      message: "启用公开评论样本需要绑定有效的实验性公开样本 Provider"
    });
  }
}

export const acquisitionPlanPayloadContractSchema =
  acquisitionPlanPayloadSchema.superRefine(
    refineDouyinPublicCommentSampleBinding
  );

export const acquisitionPublicPlanCreateSchema =
  acquisitionPlanPayloadSchema
    .omit({ modelSnapshotRef: true })
    .extend({ modelConnectionId: idSchema.nullable().optional() })
    .strict()
    .superRefine(refineDouyinPublicCommentSampleBinding);

export type AcquisitionPublicPlanCreateInput =
  z.infer<typeof acquisitionPublicPlanCreateSchema>;
