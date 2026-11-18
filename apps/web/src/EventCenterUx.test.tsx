// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { GroupedEvents } from './GroupedEvents';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('resets hidden source, project, status and search conditions without losing the selected event or rename draft', async () => {
  const group = { id: 4, title: '保留中的事件', status: 'paused', state_version: 3 };
  const scopeChange = vi.fn();
  const fetch = vi.fn(async (url: string) => {
    const params = new URL(url, 'http://localhost').searchParams;
    return new Response(JSON.stringify(url.includes('/index')
      ? { items: params.get('q') ? [] : [{ key: 'group:4', group, messages: [] }], total: params.get('q') ? 0 : 1, has_more: false, counts: { attention: 1 } }
      : { task: group, events: [], artifacts: [] }));
  });
  vi.stubGlobal('fetch', fetch);
  render(<GroupedEvents onOpenTask={vi.fn()} onManage={vi.fn()} onScopeChange={scopeChange}
    initialScope={{ status: 'needs_action', project: '7' }} projects={[{ id: 7, name: '工作项目' }]} />);
  fireEvent.click(await screen.findByRole('button', { name: /保留中的事件/ }));
  fireEvent.click(screen.getByRole('button', { name: '重命名' }));
  fireEvent.change(screen.getByLabelText('事件名称'), { target: { value: '尚未保存的名称' } });
  fireEvent.click(screen.getByRole('button', { name: /筛选/ }));
  fireEvent.change(screen.getByLabelText('来源'), { target: { value: 'redmine' } });
  fireEvent.click(screen.getByRole('button', { name: /筛选/ }));
  const conditions = screen.getByLabelText('当前筛选条件');
  expect(conditions.textContent).toContain('Redmine');
  expect(conditions.textContent).toContain('工作项目');
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '没有匹配的关键词' } });
  await screen.findByText('暂无匹配事件。');
  fireEvent.click(screen.getByRole('button', { name: '查看全部事件' }));
  await waitFor(() => {
    const requestUrl = fetch.mock.calls.filter(([url]) => url.includes('/index')).at(-1)![0];
    const params = new URL(requestUrl, 'http://localhost').searchParams;
    expect(params.get('q')).toBe('');
    expect(params.get('source')).toBe('');
    expect(params.get('status')).toBe('');
    expect(params.has('project_id')).toBe(false);
  });
  expect(scopeChange).toHaveBeenLastCalledWith({ status: '', project: '' });
  expect(document.activeElement).toBe(screen.getByRole('searchbox'));
  expect((screen.getByLabelText('事件名称') as HTMLInputElement).value).toBe('尚未保存的名称');
  expect(screen.getByRole('heading', { name: group.title })).toBeTruthy();
});

it('does not mistake a list request failure for an empty result and allows retry', async () => {
  let fails = true;
  vi.stubGlobal('fetch', vi.fn(async () => fails
    ? new Response(JSON.stringify({ detail: '列表暂时不可用' }), { status: 503 })
    : new Response(JSON.stringify({ items: [], total: 0, has_more: false }))));
  render(<GroupedEvents onOpenTask={vi.fn()} onManage={vi.fn()} />);
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.queryByText('暂无事件。')).toBeNull();
  fails = false;
  fireEvent.click(screen.getByRole('button', { name: '刷新事件' }));
  expect(await screen.findByText('暂无事件。')).toBeTruthy();
  expect(within(screen.getByText('暂无事件。').parentElement!).queryByRole('button')).toBeNull();
});
