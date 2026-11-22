import { describe, expect, test } from 'bun:test';
import type { Instance } from '@nf-hub/protocol';
import { connectionLabel, countLabel, emptySessionMessage, projectLabel, relativeTime, scopeLabel, sessionKey, sortedInstances, statusLabels } from '../src/lib/format';

describe('中文摘要展示', () => {
  test('null 未同步不冒充明确空快照', () => {
    expect(countLabel(null)).toBe('—');
    expect(countLabel(undefined)).toBe('—');
    expect(countLabel(0)).toBe('0');
    expect(countLabel(1234)).toBe('1,234');
  });
  test('waiting 只是等待中，未知与归档有独立名称', () => {
    expect(statusLabels.waiting).toBe('等待中');
    expect(statusLabels.unknown).toBe('未知');
    expect(statusLabels.archived).toBe('已归档');
  });
  test('项目为空独立，名称缺失用 ID', () => {
    expect(projectLabel({ projectId: null })).toBe('独立会话');
    expect(projectLabel({ projectId: 'project-7' })).toBe('project-7');
    expect(projectLabel({ projectId: 'project-7', projectName: '项目名称' })).toBe('项目名称');
  });
  test('复合行键不会跨实例串会话或受分隔符影响', () => {
    expect(sessionKey({ instanceId: 'a', id: 'same' })).not.toBe(sessionKey({ instanceId: 'b', id: 'same' }));
    expect(sessionKey({ instanceId: 'a|b', id: 'c' })).not.toBe(sessionKey({ instanceId: 'a', id: 'b|c' }));
  });
  test('联络与完整同步不混淆，失联不宣称主机停机', () => {
    expect(connectionLabel({ connection: 'connected', freshness: 'never', lastError: null })).toBe('等待首次同步');
    expect(connectionLabel({ connection: 'connected', freshness: 'stale', lastError: null })).toBe('数据过期');
    expect(connectionLabel({ connection: 'connected', freshness: 'fresh', lastError: 'QUERY_FAILED' })).toBe('同步失败');
    expect(connectionLabel({ connection: 'lost', freshness: 'stale', lastError: null })).toBe('上报失联');
    expect(connectionLabel({ connection: 'revoked', freshness: 'never', lastError: null })).toBe('已撤销');
  });
  test('范围默认 none，独立选择与归档明确展示', () => {
    expect(scopeLabel({ mode: 'none', includeArchived: false })).toBe('未发布（范围为空）');
    expect(scopeLabel({ mode: 'projects', includeArchived: false, projectIds: ['p'], includeStandalone: true })).toBe('1 个项目及独立会话，不含归档');
    expect(scopeLabel({ mode: 'sessions', includeArchived: true, sessionIds: ['s'] })).toBe('1 个指定会话，含归档');
  });
  test('最近活动使用 Unix ms，并避免未来显示负数', () => {
    expect(relativeTime(null, 10_000)).toBe('—');
    expect(relativeTime(10_001, 10_000)).toBe('刚刚');
    expect(relativeTime(1_000, 121_000)).toBe('2 分钟前');
    expect(relativeTime(1_000, 7_201_000)).toBe('2 小时前');
  });
  test('空态分清未配置、筛选为空和等待同步', () => {
    expect(emptySessionMessage(false, false).title).toBe('先接入一台 NF');
    expect(emptySessionMessage(true, true).title).toBe('没有匹配的会话');
    expect(emptySessionMessage(true, false).detail).toContain('首次同步');
  });
  test('排序收藏优先，其后数字，且不改原数组', () => {
    const item = (id: string, favorite: boolean, order: number) => ({ id, alias: id, favorite, order }) as Instance;
    const input = [item('a', false, 0), item('b', true, 100), item('c', false, -1)];
    expect(sortedInstances(input).map(value => value.id)).toEqual(['b', 'c', 'a']);
    expect(input.map(value => value.id)).toEqual(['a', 'b', 'c']);
  });
});
