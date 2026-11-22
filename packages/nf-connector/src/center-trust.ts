import { X509Certificate, createHash } from "node:crypto";
import { ConnectorError } from "./errors";
import { publicCertBody } from "./pem";

export interface CenterTrust { centerCaPem: string | null; centerCaSha256: string | null; }
export const DEFAULT_TRUST: Readonly<CenterTrust> = { centerCaPem: null, centerCaSha256: null };

/** Only null/omitted means default trust. A supplied but invalid CA must never fall back to it. */
export function centerTrust(pem: unknown, expected: unknown): CenterTrust {
  if (pem == null && expected == null) return { ...DEFAULT_TRUST };
  const body = publicCertBody(pem);
  if (!body) throw new ConnectorError("CA_INVALID", true);
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(Buffer.from(body, "base64"));
    // X.509 parsers may accept trailing DER bytes; persist only one exact public CA certificate.
    if (!cert.ca || cert.raw.toString("base64") !== body) throw new Error();
  } catch { throw new ConnectorError("CA_INVALID", true); }
  const fingerprint = createHash("sha256").update(cert.raw).digest("hex");
  if (expected !== fingerprint) throw new ConnectorError("CA_FINGERPRINT_MISMATCH", true);
  return { centerCaPem: cert.toString(), centerCaSha256: fingerprint };
}
