import { QueueItemRecord } from '../repository/types';

export interface QueueClaimResult {
  taskId: string;
  workerId: string;
  claimToken: string;
  claimedAt: number;
  leaseExpiresAt: number;
  attempt: number;
}

export interface QueueWorkerSnapshot {
  active: QueueItemRecord[];
  retryWaiting: QueueItemRecord[];
}
