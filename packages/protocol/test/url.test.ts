import { expect, test } from 'bun:test';
import { buildNarratorUrl, normalizeBrowserBaseUrl } from '../src';

test('规范化实例基址且保持子路径；深链 ID 严格编码为一个路径段',()=>{
  const base=normalizeBrowserBaseUrl('https://NF.example.invalid:443/prefix/','https://hub.example.invalid');
  expect(base).toBe('https://nf.example.invalid/prefix');
  const id='组/a?#%', target=buildNarratorUrl(base,id);
  expect(target).toBe(`${base}/narrators/${encodeURIComponent(id)}`);
  expect(new URL(target).origin).toBe('https://nf.example.invalid');
  for(const invalid of ['.','..','','\t','\ud800']) expect(()=>buildNarratorUrl(base,invalid)).toThrow();
});
test('拒绝同主机跨端口、公开 HTTP 和带查询/用户信息/片段的基址',()=>{
  const hub='https://hub.example.invalid';
  for(const raw of ['https://hub.example.invalid:8443/instance','https://demo@example.invalid','https://nf.example.invalid/#','https://nf.example.invalid/?','http://localhost:7777','http://example.invalid','https://*.example.invalid']) expect(()=>normalizeBrowserBaseUrl(raw,hub)).toThrow();
  expect(normalizeBrowserBaseUrl('http://localhost:7777/nf','http://127.0.0.1:17900')).toBe('http://localhost:7777/nf');
});
