import type { ErrorCode } from '@nf-hub/protocol';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ZodType } from 'zod';

export class Fault extends Error {
  constructor(readonly status: ContentfulStatusCode, readonly code: ErrorCode) { super(code); }
}
export function fail(status: ContentfulStatusCode, code: ErrorCode): never { throw new Fault(status, code); }
export function validated<T>(schema: ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) fail(400, 'INVALID_INPUT'); // Never echo rejected fields or validation context.
  return parsed.data;
}
