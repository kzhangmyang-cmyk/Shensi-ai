export interface AcquisitionMasterSecretEnvironment {
  nodeEnv?: string;
  acquisitionMasterSecret?: string;
  jwtSecret?: string;
}

function strongSecret(value: string) {
  const normalized = value.trim();
  if (Buffer.byteLength(normalized, "utf8") < 32) {
    throw new Error(
      "Acquisition master secret must contain at least 32 non-whitespace bytes"
    );
  }
  return normalized;
}

export function resolveAcquisitionMasterSecret(
  environment: AcquisitionMasterSecretEnvironment
) {
  const nodeEnv = environment.nodeEnv?.trim() || "development";
  const dedicated = environment.acquisitionMasterSecret?.trim() ?? "";
  if (nodeEnv === "production") {
    if (!dedicated) {
      throw new Error(
        "ACQUISITION_MASTER_SECRET is required in production"
      );
    }
    return strongSecret(dedicated);
  }
  return strongSecret(
    dedicated || environment.jwtSecret?.trim() || ""
  );
}

