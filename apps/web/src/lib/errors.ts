import type { ErrorCode } from '@nf-hub/protocol';

export type ClientErrorCode = ErrorCode | 'NETWORK' | 'INVALID_RESPONSE' | 'SESSION_CHANGED';
export class ApiError extends Error {
  constructor(public readonly code: ClientErrorCode, public readonly status = 0) {
    super(code);
    this.name = 'ApiError';
  }
}
const messages: Record<ClientErrorCode, string> = {
  UNAUTHENTICATED: '登录已失效，请重新登录。', FORBIDDEN: '当前账号没有此操作权限。',
  BAD_ORIGIN: '访问来源未获信任，请从配置的中心地址访问。', CSRF: '安全校验已失效，请刷新页面后重试。',
  INVALID_INPUT: '填写内容不符合要求，请检查后重试。', INVALID_PAIRING: '配对码无效或已过期，请撤销后重新生成。',
  NOT_FOUND: '此记录已不存在，请刷新列表。', CONFLICT: '操作发生冲突，请刷新后重试；实例需使用独立访问地址。',
  REVOKE_FIRST: '已有配对或待配对授权，请先撤销旧授权，再生成新的配对码。',
  INVALID_SCOPE: '发布范围无效，请在 NF 插件设置中重新选择。', DUPLICATE_ID: '摘要出现重复标识，请检查插件同步状态。',
  HASH_MISMATCH: '摘要完整性校验失败，请在 NF 插件中重新同步。', COUNT_MISMATCH: '摘要数量不一致，请重新同步。',
  STALE_RUN: '同步轮次已过时，请由插件重新同步。', RUN_EXPIRED: '同步轮次已过期。', RUN_CLOSED: '同步轮次已关闭。',
  TOO_LARGE: '数据超过接收上限，请缩小发布范围。', RATE_LIMITED: '操作过于频繁，请稍后重试。',
  BUSY: '服务正在处理其他请求，请稍后重试。', UNSUPPORTED_MEDIA: '请求格式不受支持。',
  INTERNAL: '中心服务暂时出错，请稍后重试。', NETWORK: '无法连接中心服务，请检查网络后重试。',
  INVALID_RESPONSE: '中心返回的数据格式不兼容，请核对服务与前端版本。',
  SESSION_CHANGED: '连接授权已更新，请重试。',
};
export function errorMessage(error: unknown): string {
  return error instanceof ApiError ? messages[error.code] : '发生未预期的错误，请重试；若持续出现，请检查中心服务日志。';
}
