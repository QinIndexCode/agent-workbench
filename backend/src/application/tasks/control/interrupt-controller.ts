import crypto from 'node:crypto';

interface ActiveInterruptLease {
  leaseId: string;
  controller: AbortController;
}

export class InterruptController {
  private readonly activeLeases = new Map<string, ActiveInterruptLease>();

  begin(taskId: string): { leaseId: string; signal: AbortSignal } {
    const active = this.activeLeases.get(taskId);
    active?.controller.abort();
    const leaseId = `lease_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const controller = new AbortController();
    this.activeLeases.set(taskId, {
      leaseId,
      controller
    });
    return {
      leaseId,
      signal: controller.signal
    };
  }

  end(taskId: string, leaseId: string): void {
    const active = this.activeLeases.get(taskId);
    if (!active || active.leaseId !== leaseId) {
      return;
    }
    this.activeLeases.delete(taskId);
  }

  requestInterrupt(taskId: string): boolean {
    const active = this.activeLeases.get(taskId);
    if (!active) {
      return false;
    }
    active.controller.abort();
    return true;
  }

  isActive(taskId: string): boolean {
    return this.activeLeases.has(taskId);
  }
}
