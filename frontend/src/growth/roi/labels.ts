const reasonLabels: Readonly<Record<string, string>> = {
  missing_probability: "缺少成交概率",
  missing_estimated_cost: "缺少预计获客成本",
  zero_estimated_cost: "预计获客成本为零",
  cohort_not_closed: "获客批次尚未关账",
  unverified_cost: "获客成本尚未核实",
  unverified_financial_fact: "财务记录尚未核实",
  missing_cogs: "缺少销售成本",
  unmatched_payment: "回款尚未完成匹配",
  missing_commercial_binding: "缺少客户或商机关联",
  import_requires_review: "导入资料仍需复核",
  zero_verified_cost: "已核实获客成本为零",
  query_truncated: "查询范围过大，请缩小范围",
  zero_acquisition_cost: "获客成本为零",
  zero_verified_contract: "已核实合同金额为零"
};

export function roiReasonLabel(reason: string): string {
  return reasonLabels[reason] ?? "相关业务数据尚未准备完整";
}

export function roiStatusLabel(status: "computed" | "not_computable" | "not_available"): string {
  return status === "computed" ? "已计算" : status === "not_computable" ? "暂不可计算" : "暂不可用";
}

export function roiRequestMessage(message: string): string {
  if (message === "stale_query") return "查询范围已变化，请重新查询。";
  if (message === "idempotency_conflict") return "查询状态已变化，请刷新后重试。";
  let readable = message;
  try {
    const parsed = JSON.parse(message) as { message?: unknown; error?: { message?: unknown } };
    const text = parsed.error?.message ?? parsed.message;
    if (typeof text === "string") readable = text;
  } catch {
    // Plain backend messages need no envelope decoding.
  }
  return /[\u3400-\u9fff]/u.test(readable)
    ? readable : "ROI 查询暂时失败，请稍后重试。";
}
