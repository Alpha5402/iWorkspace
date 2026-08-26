// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import RunStatusBadge from './RunStatusBadge.vue';

describe('RunStatusBadge', () => {
  it('uses the frozen status presentation without creating a fake Run', () => {
    const wrapper = mount(RunStatusBadge, { props: { status: 'WAITING_APPROVAL' } });

    expect(wrapper.text()).toBe('等待审批');
    expect(wrapper.attributes('data-tone')).toBe('warning');
  });
});
