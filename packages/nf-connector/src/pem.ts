export const MAX_CA_PEM_CHARS = 16 * 1024;
/** Shared preflight: do not hand paths, private keys, bundles or surrounding text to the host bridge. */
export function publicCertBody(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > MAX_CA_PEM_CHARS || /[^\x09\x0a\x0d\x20-\x7e]/u.test(raw)) return null;
  const m = /^-----BEGIN CERTIFICATE-----\n([A-Za-z0-9+/=\n]+)\n-----END CERTIFICATE-----$/.exec(raw.trim().replace(/\r\n/g, "\n"));
  const body = m?.[1]?.replace(/\n/g, "");
  return body && body.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(body) ? body : null;
}
