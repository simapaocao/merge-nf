import { CSRF_HEADER, errorResponseSchema, type Auth } from '@nf-hub/protocol';
import { ApiError } from './errors';

type Schema<T> = { safeParse: (value: unknown) => { success: true; data: T } | { success: false } };
type Options = { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown; signal?: AbortSignal; headers?: Record<string,string>; allow304?: boolean; readEpoch?: number };

export class ApiClient {
  private auth: Auth | null = null;
  private sessionEpoch = 0;
  private epoch = 0;
  private version: string | null = null;
  private requests = new Map<AbortController,boolean>();
  onUnauthorized: (() => void) | undefined;
  constructor(private transport: (path: string, init: RequestInit) => Promise<Response> = (path,init) => fetch(path,init)) {}
  setAuth(auth: Auth | null) { this.auth = auth; }
  get readEpoch() { return this.epoch; }
  get readVersion() { return this.version; }
  /** A dashboard change invalidates reads only. It must not abort an administrator's submitted write. */
  fenceReads(version: string | null) {
    this.version=version; ++this.epoch;
    for (const [controller,privateRead] of this.requests) if (privateRead) controller.abort();
    return this.epoch;
  }
  reset() {
    ++this.sessionEpoch; this.fenceReads(null);
    for (const controller of this.requests.keys()) controller.abort();
    this.requests.clear();
  }
  async request<T>(path: string, schema: Schema<T>, options: Options = {}): Promise<{ data: T | null; etag: string | null }> {
    if (!path.startsWith('/api/') || path.startsWith('//')) throw new ApiError('INVALID_INPUT');
    const session = this.sessionEpoch, {method='GET',readEpoch} = options;
    const assertCurrent = () => {
      if (session !== this.sessionEpoch || (readEpoch !== undefined && (method !== 'GET' || !this.version || readEpoch !== this.epoch))) throw new ApiError('SESSION_CHANGED');
      options.signal?.throwIfAborted();
    };
    assertCurrent();
    const controller = new AbortController(); this.requests.set(controller,readEpoch !== undefined);
    const headers = new Headers(options.headers); headers.set('Accept','application/json');
    if (options.body !== undefined) headers.set('Content-Type','application/json');
    if (method !== 'GET' && this.auth) headers.set(CSRF_HEADER,this.auth.csrfToken);
    try {
      const response = await this.transport(path,{method,credentials:'same-origin',cache:'no-store',redirect:'error',headers,
        signal:options.signal ? AbortSignal.any([controller.signal,options.signal]) : controller.signal,
        ...(options.body === undefined ? {} : {body:JSON.stringify(options.body)})});
      assertCurrent();
      if (response.status === 401) { this.auth=null; this.onUnauthorized?.(); throw new ApiError('UNAUTHENTICATED',401); }
      if (response.status === 304 && options.allow304) return {data:null,etag:response.headers.get('ETag')};
      if (response.status === 204 && response.ok) return {data:null,etag:null};
      let value: unknown;
      try { value=await response.json(); } catch { assertCurrent(); throw new ApiError('INVALID_RESPONSE',response.status); }
      assertCurrent();
      if (!response.ok) {
        const parsed=errorResponseSchema.safeParse(value); throw new ApiError(parsed.success ? parsed.data.error.code : 'INVALID_RESPONSE',response.status);
      }
      const parsed=schema.safeParse(value); if (!parsed.success) throw new ApiError('INVALID_RESPONSE',response.status);
      return {data:parsed.data,etag:response.headers.get('ETag')};
    } catch (error) {
      if (error instanceof ApiError) throw error;
      assertCurrent(); if (controller.signal.aborted) throw error;
      throw new ApiError('NETWORK');
    } finally { this.requests.delete(controller); }
  }
  async read<T>(path:string,schema:Schema<T>,signal?:AbortSignal,readEpoch?:number):Promise<T> {
    const result=await this.request(path,schema,{signal,readEpoch});
    if (readEpoch !== undefined && (readEpoch !== this.epoch || !this.version)) throw new ApiError('SESSION_CHANGED');
    if (result.data === null) throw new ApiError('INVALID_RESPONSE'); return result.data;
  }
}
export const api=new ApiClient();
