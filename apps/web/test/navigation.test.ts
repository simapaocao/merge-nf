import { describe, expect, test } from 'bun:test';
import { buildNarratorUrl, normalizeBrowserBaseUrl } from '@nf-hub/protocol';
import { intentHash, isMixedContent, parseIntent } from '../src/lib/navigation';

describe('工作台目标与页面意图', () => {
  test('只接受三个界面路由，不从 hash 打开外站', () => {
    expect(parseIntent('#https://untrusted.invalid')).toEqual({ view: 'sessions', instanceId: undefined, sessionId: undefined });
    expect(parseIntent('#connections?instance=one&session=ignored')).toEqual({ view: 'connections', instanceId: 'one', sessionId: undefined });
  });
  test('跨实例深链保留任意会话 ID，不误解斜杠、查询、片段', () => {
    const intent = { view: 'workbench' as const, instanceId: 'instance-a', sessionId: '中文/a?b#c&d' };
    expect(parseIntent(intentHash(intent))).toEqual(intent);
    expect(intentHash(intent)).toContain('instance=instance-a');
  });
  test('会话深链由共享函数构建，保留已有 basePath 并编码 ID', () => {
    const base = normalizeBrowserBaseUrl('https://nf.example.net/team/nf/', 'https://hub.example.net');
    const target = new URL(buildNarratorUrl(base, '中文/a?b#c'));
    expect(target.origin).toBe('https://nf.example.net');
    expect(target.pathname).toBe('/team/nf/narrators/%E4%B8%AD%E6%96%87%2Fa%3Fb%23c');
    expect(target.search).toBe('');
    expect(target.hash).toBe('');
  });
  test('hub 与 NF 即使端口不同也不能用同 hostname', () => {
    expect(() => normalizeBrowserBaseUrl('https://hub.example.net:8443', 'https://hub.example.net')).toThrow();
  });
  test('混合内容提示独立于同步状态', () => {
    expect(isMixedContent('https://hub.example.net', 'http://nf.example.net')).toBe(true);
    expect(isMixedContent('https://hub.example.net', 'https://nf.example.net')).toBe(false);
    expect(isMixedContent('http://127.0.0.1:17900', 'http://localhost:17902')).toBe(false);
  });
});
