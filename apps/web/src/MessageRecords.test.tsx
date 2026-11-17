// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MessageRecords } from './MessageRecords';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('消息详情仅展示相关消息和对应事件入口', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/trace') ? {
    task: { id: 7, title: '德阳问题' }, related_events: [{ id: 2, content: '后续补充', actor_name: '用户' }],
  } : { items: [{ id: 1, source: 'dingtalk', content: '最初消息', created_at: '2026-11-15T00:00:00Z', data: { actor_id: '用户' } }], has_more: false }))));
  const open = vi.fn();
  const user = userEvent.setup();
  render(<MessageRecords onOpenEvent={open} />);
  await user.click(await screen.findByRole('button', { name: /最初消息/ }));
  await screen.findByText('后续补充');
  expect(screen.queryByText('处理进度')).toBeNull();
  await user.click(screen.getByRole('button', { name: '进入对应事件' }));
  expect(open).toHaveBeenCalledWith('7');
  expect(screen.queryByRole('button', { name: '下一页' })).toBeNull();
});
