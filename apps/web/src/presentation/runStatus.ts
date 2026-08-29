import { type RunStatus } from '@delivery/contracts';

export type RunStatusPresentation = Readonly<{
  label: string;
  tone: 'danger' | 'info' | 'neutral' | 'success' | 'warning';
}>;

export const runStatusPresentation = {
  ACCEPTED: { label: '已受理', tone: 'info' },
  CANCELLED: { label: '已取消', tone: 'neutral' },
  FAILED: { label: '失败', tone: 'danger' },
  PARTIAL: { label: '部分完成', tone: 'warning' },
  QUEUED: { label: '排队中', tone: 'info' },
  RUNNING: { label: '运行中', tone: 'info' },
  STALE: { label: '已失效', tone: 'warning' },
  SUCCEEDED: { label: '成功', tone: 'success' },
} as const satisfies Record<RunStatus, RunStatusPresentation>;
