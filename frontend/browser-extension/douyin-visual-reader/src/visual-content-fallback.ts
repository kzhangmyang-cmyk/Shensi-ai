import type { VisualObservationSubmission } from "./protocol";
import { parseVisualCaptureEvidence } from "./visual-capture-runtime";
import { resolveObservationWithVisualFallback } from "./visual-pipeline";

function exactResponse(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Object.keys(value);
  return keys.length === 2 && Object.hasOwn(value, "accepted") && Object.hasOwn(value, "evidence");
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function retainTruncatedDom(observation: VisualObservationSubmission): VisualObservationSubmission {
  return {
    ...observation,
    fieldConfidences: {
      ...observation.fieldConfidences,
      visibleText: Math.min(0.84, observation.fieldConfidences.visibleText ?? 0.84)
    },
    redactedCrop: null
  };
}

export async function resolveVisualCaptureResponse(input: {
  observation: VisualObservationSubmission;
  domTextState: "missing" | "truncated";
  response: unknown;
}): Promise<VisualObservationSubmission | null> {
  if (!exactResponse(input.response) || input.response.accepted !== true) {
    return input.domTextState === "truncated" ? retainTruncatedDom(input.observation) : null;
  }
  const evidence = parseVisualCaptureEvidence(input.response.evidence);
  if (!evidence) return input.domTextState === "truncated" ? retainTruncatedDom(input.observation) : null;
  const bytes = decodeBase64(evidence.contentBase64);
  try {
    const resolved = await resolveObservationWithVisualFallback({
      observation: input.observation,
      artifactUploadEnabled: true,
      domTextState: input.domTextState,
      capture: async () => ({
        mediaType: evidence.mediaType,
        contentBase64: evidence.contentBase64,
        bytes,
        width: evidence.width,
        height: evidence.height,
        redactionProof: evidence.redactionProof
      }),
      ocr: { async recognize() { return evidence.ocrResult; } }
    });
    return (resolved.observation ?? (input.domTextState === "truncated"
      ? retainTruncatedDom(input.observation)
      : null)) as VisualObservationSubmission | null;
  } catch {
    return input.domTextState === "truncated" ? retainTruncatedDom(input.observation) : null;
  } finally {
    bytes.fill(0);
  }
}

export async function requestVisualCaptureFallback(input: {
  observation: VisualObservationSubmission;
  domTextState: "missing" | "truncated";
  sendMessage: () => Promise<unknown>;
}): Promise<VisualObservationSubmission | null> {
  let response: unknown;
  try {
    response = await input.sendMessage();
  } catch {
    response = { accepted: false, evidence: null };
  }
  return resolveVisualCaptureResponse({
    observation: input.observation,
    domTextState: input.domTextState,
    response
  });
}
