// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import UiStatePanel from './UiStatePanel.vue';

describe('shared UI states', () => {
  it.each([
    ['loading', '加载中'],
    ['empty', '暂无内容'],
    ['error', '发生了未预期的错误'],
  ] as const)('renders the %s state', (state, title) => {
    expect(mount(UiStatePanel, { props: { state } }).text()).toContain(title);
  });
});
