import { createHash, randomUUID } from "node:crypto";
import { canonicalJsonStringify } from "./canonical-json.js";
import { GrowthHttpError } from "./growth-command-context.js";

export interface GrowthHttpIdempotencyReservationInput {
  workspaceId: string;
  actorId: string;
  method: string;
  canonicalPath: string;
  key: string;
  requestHash: string;
  attemptedAt: string;
  leaseOwner: string;
  leaseDurationMs: number;
}

export type GrowthHttpIdempotencyReservation =
  | { kind: "claimed"; reservationId: string; leaseOwner: string; leaseExpiresAt: string; fencingToken: number }
  | { kind: "in_progress"; retryAfterMs: number }
  | { kind: "replay"; resourceId: string | null; operationId: string | null }
  | { kind: "conflict" };

export interface GrowthHttpIdempotencyRepository {
  reserve(input: GrowthHttpIdempotencyReservationInput): Promise<GrowthHttpIdempotencyReservation>;
  complete(reservationId: string, leaseOwner: string, fencingToken: number, result: { resourceId: string | null; operationId: string | null }): Promise<void>;
  release(reservationId: string, leaseOwner: string, fencingToken: number): Promise<void>;
}

interface ReservationRecord extends GrowthHttpIdempotencyReservationInput {
  reservationId: string;
  leaseExpiresAt: string;
  fencingToken: number;
  status: "reserved" | "completed";
  resourceId: string | null;
  operationId: string | null;
}

function concrete(value: string, code: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

export function growthHttpIdempotencyKeyHash(key: string): `sha256:${string}` {
  if (!key.trim()) throw new Error("invalid_idempotency_key");
  return `sha256:${createHash("sha256").update(key).digest("hex")}`;
}

function validate(input: GrowthHttpIdempotencyReservationInput) {
  concrete(input.workspaceId, "invalid_growth_workspace_id");
  concrete(input.actorId, "invalid_growth_actor_id");
  concrete(input.method, "invalid_growth_method");
  concrete(input.canonicalPath, "invalid_growth_canonical_path");
  growthHttpIdempotencyKeyHash(input.key);
  if (!/^sha256:[a-f0-9]{64}$/u.test(input.requestHash)) throw new Error("invalid_idempotency_request_hash");
  concrete(input.leaseOwner, "invalid_idempotency_lease_owner");
  if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs < 1) throw new Error("invalid_idempotency_lease_duration");
  const attemptedAt = new Date(input.attemptedAt);
  if (Number.isNaN(attemptedAt.getTime())) throw new Error("invalid_idempotency_attempted_at");
  return attemptedAt;
}

function scope(input: GrowthHttpIdempotencyReservationInput): string {
  return [input.workspaceId, input.actorId, input.method, input.canonicalPath, growthHttpIdempotencyKeyHash(input.key)].join("\u0000");
}

function expiresAt(attemptedAt: Date, leaseDurationMs: number) {
  return new Date(attemptedAt.getTime() + leaseDurationMs).toISOString();
}

export class InMemoryGrowthHttpIdempotencyRepository implements GrowthHttpIdempotencyRepository {
  private readonly byScope = new Map<string, ReservationRecord>();
  private readonly byId = new Map<string, ReservationRecord>();

  async reserve(input: GrowthHttpIdempotencyReservationInput): Promise<GrowthHttpIdempotencyReservation> {
    const attemptedAt = validate(input);
    const existing = this.byScope.get(scope(input));
    if (!existing) {
      const record: ReservationRecord = {
        ...input, reservationId: randomUUID(), leaseExpiresAt: expiresAt(attemptedAt, input.leaseDurationMs), fencingToken: 1,
        status: "reserved", resourceId: null, operationId: null
      };
      this.byScope.set(scope(input), record);
      this.byId.set(record.reservationId, record);
      return { kind: "claimed", reservationId: record.reservationId, leaseOwner: record.leaseOwner, leaseExpiresAt: record.leaseExpiresAt, fencingToken: record.fencingToken };
    }
    if (existing.requestHash !== input.requestHash) return { kind: "conflict" };
    if (existing.status === "completed") return { kind: "replay", resourceId: existing.resourceId, operationId: existing.operationId };
    const expiry = new Date(existing.leaseExpiresAt).getTime();
    if (attemptedAt.getTime() < expiry) return { kind: "in_progress", retryAfterMs: expiry - attemptedAt.getTime() };
    existing.leaseOwner = input.leaseOwner;
    existing.leaseExpiresAt = expiresAt(attemptedAt, input.leaseDurationMs);
    existing.fencingToken += 1;
    return { kind: "claimed", reservationId: existing.reservationId, leaseOwner: existing.leaseOwner, leaseExpiresAt: existing.leaseExpiresAt, fencingToken: existing.fencingToken };
  }

  async complete(reservationId: string, leaseOwner: string, fencingToken: number, result: { resourceId: string | null; operationId: string | null }): Promise<void> {
    const record = this.byId.get(reservationId);
    if (!record || record.status !== "reserved" || record.leaseOwner !== leaseOwner || record.fencingToken !== fencingToken) throw new Error("stale_idempotency_fence");
    record.status = "completed";
    record.resourceId = result.resourceId;
    record.operationId = result.operationId;
  }

  async release(reservationId: string, leaseOwner: string, fencingToken: number): Promise<void> {
    const record = this.byId.get(reservationId);
    if (!record || record.status !== "reserved" || record.leaseOwner !== leaseOwner || record.fencingToken !== fencingToken) throw new Error("stale_idempotency_fence");
    this.byId.delete(reservationId);
    this.byScope.delete(scope(record));
  }
}

export async function executeGrowthIdempotentCommand<T>(input: {
  repository: GrowthHttpIdempotencyRepository;
  reservation: GrowthHttpIdempotencyReservationInput;
}, authorizeAndProject: (resourceId: string | null, operationId: string | null) => Promise<T>, execute: () => Promise<{ resourceId: string | null; operationId: string | null }>): Promise<{ value: T; replayed: boolean }> {
  const reservation = await input.repository.reserve(input.reservation);
  if (reservation.kind === "conflict") throw new GrowthHttpError(409, "idempotency_conflict");
  if (reservation.kind === "in_progress") {
    const error = new GrowthHttpError(409, "idempotency_in_progress");
    Object.assign(error, {
      retryAfterMs: reservation.retryAfterMs,
      retryAfter: Math.max(1, Math.ceil(reservation.retryAfterMs / 1_000))
    });
    throw error;
  }
  if (reservation.kind === "replay") return { value: await authorizeAndProject(reservation.resourceId, reservation.operationId), replayed: true };
  let executed = false;
  try {
    const result = await execute();
    executed = true;
    await input.repository.complete(reservation.reservationId, reservation.leaseOwner, reservation.fencingToken, result);
    return { value: await authorizeAndProject(result.resourceId, result.operationId), replayed: false };
  } catch (error) {
    if (!executed) {
      await input.repository.release(
        reservation.reservationId,
        reservation.leaseOwner,
        reservation.fencingToken
      ).catch(() => undefined);
    }
    throw error;
  }
}

export function canonicalGrowthRequestHash(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJsonStringify(value)).digest("hex")}`;
}
