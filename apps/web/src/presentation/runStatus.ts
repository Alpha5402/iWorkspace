import { type RunStatus } from '@delivery/contracts';

export type RunStatusPresentation = Readonly<{
  label: string;
  tone: 'danger' | 'info' | 'neutral' | 'success' | 'warning';
}>;

export const runStatusPresentation = {
  CANCELLED: { label: '已取消', tone: 'neutral' },
  CANCEL_REQUESTED: { label: '正在取消', tone: 'warning' },
  DRAFT: { label: '草稿', tone: 'neutral' },
  FAILED: { label: '失败', tone: 'danger' },
  QUEUED: { label: '排队中', tone: 'info' },
  REJECTED: { label: '已拒绝', tone: 'danger' },
  RUNNING: { label: '运行中', tone: 'info' },
  STALE: { label: '已失效', tone: 'warning' },
  SUCCEEDED: { label: '成功', tone: 'success' },
  WAITING_APPROVAL: { label: '等待审批', tone: 'warning' },
} as const satisfies Record<RunStatus, RunStatusPresentation>;
