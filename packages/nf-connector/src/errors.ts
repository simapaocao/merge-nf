import { failureCodeSchema, type FailureCode } from "@nf-hub/protocol";

export type LocalErrorCode = FailureCode | "RPC_TIMEOUT" | "RPC_DENIED" | "RPC_INVALID" | "HTTP_TIMEOUT" | "HTTP_FAILED" | "RESPONSE_INVALID" | "AUTH_REJECTED" | "CONFIG_INVALID" | "CONSENT_REQUIRED" | "PAIRING_REQUIRED" | "PAIRING_FAILED" | "PAIRING_UNCERTAIN" | "CENTRAL_REVOCATION_REQUIRED" | "BASE_URL_CHANGED" | "CA_CHANGED" | "CA_INVALID" | "CA_FINGERPRINT_MISMATCH" | "SCOPE_CHANGED" | "INACTIVE" | "BUSY" | "SECRET_UNAVAILABLE" | "RUN_EXPIRED";
export class ConnectorError extends Error {
  constructor(readonly code: LocalErrorCode, readonly terminal = false) {
    super(code); this.name = "ConnectorError";
  }
}
export function safeError(error: unknown): LocalErrorCode {
  return error instanceof ConnectorError ? error.code : "HOST_UNAVAILABLE";
}
export function collectionFailure(error: unknown): FailureCode {
  const code = safeError(error);
  const parsed = failureCodeSchema.safeParse(code);
  return parsed.success ? parsed.data : code === "RPC_TIMEOUT" ? "COLLECTION_TIMEOUT" : "HOST_UNAVAILABLE";
}
export function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ConnectorError("CANCELLED");
}
