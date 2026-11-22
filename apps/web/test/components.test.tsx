import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConnectionPill, EmptyState, ErrorBanner, SessionPill } from '../src/components/Common';
import { ApiError } from '../src/lib/errors';
import type { Instance } from '@nf-hub/protocol';

describe('组件文案与转义', () => {
  test('waiting 没有需人工处理的暗示', () => {
    const html = renderToStaticMarkup(<SessionPill status="waiting" />);
    expect(html).toContain('等待中');
    expect(html).not.toContain('需人工');
  });
  test('旧运行快照不使用当前运行强调色', () => {
    const html = renderToStaticMarkup(<SessionPill status="working" old />);
    expect(html).toContain('pill neutral');
    expect(html).not.toContain('pill teal');
  });
  test('旧摘要文字按纯文本输出', () => {
    const html = renderToStaticMarkup(<EmptyState title={'<script>alert(1)</script>'} detail="只读摘要" />);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
  test('请求错误给中文提示和可读错误码，未知错误不吞掉', () => {
    const html = renderToStaticMarkup(<ErrorBanner error={new ApiError('REVOKE_FIRST', 409)} />);
    expect(html).toContain('先撤销旧授权');
    expect(html).toContain('REVOKE_FIRST');
    expect(html).toContain('role="alert"');
    expect(renderToStaticMarkup(<ErrorBanner error={new Error('private internal message')} />)).toContain('未预期的错误');
    expect(renderToStaticMarkup(<ErrorBanner error={new Error('private internal message')} />)).not.toContain('private internal');
  });
  test('从未同步不会显示为有效已连接', () => {
    const instance = { connection: 'connected', freshness: 'never', lastError: null } as Instance;
    const html = renderToStaticMarkup(<ConnectionPill instance={instance} />);
    expect(html).toContain('等待首次同步');
    expect(html).toContain('pill neutral');
  });
});
