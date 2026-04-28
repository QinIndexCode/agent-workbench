import { BackendNewFoundation } from '../../foundation/bootstrap/types';
import { PlatformMetricsView, PlatformStatisticsView } from './types';

export class StatisticsService {
  constructor(private readonly foundation: BackendNewFoundation) {}

  async getAggregate(): Promise<PlatformStatisticsView> {
    const runtimes = await this.foundation.taskRuntimes.list();
    const counts = runtimes.reduce<Record<string, number>>((accumulator, record) => {
      const key = record.runtime.lifecycleStatus;
      accumulator[key] = (accumulator[key] ?? 0) + 1;
      return accumulator;
    }, {});

    const [activeQueue, deadLetters, channels, schedules, memories] = await Promise.all([
      this.foundation.queue?.listActive() ?? Promise.resolve([]),
      this.foundation.queue?.listActive().then(items => items.filter(item => item.state === 'DEAD_LETTER')) ?? Promise.resolve([]),
      this.foundation.channels.list(),
      this.foundation.schedules.list(),
      this.foundation.memories.list()
    ]);

    return {
      taskCounts: counts,
      queue: {
        active: activeQueue.length,
        deadLetters: deadLetters.length
      },
      providers: this.foundation.providers.list().length,
      skills: this.foundation.extensions.snapshot().skills.length,
      channels: channels.length,
      schedules: schedules.length,
      memories: memories.length
    };
  }

  async getMetrics(): Promise<PlatformMetricsView> {
    const runtimes = await this.foundation.taskRuntimes.list();
    const withBudgets = runtimes.filter(record => typeof record.runtime.promptBudget?.estimatedReductionRatio === 'number');
    const averageReductionRatio = withBudgets.length > 0
      ? withBudgets.reduce((sum, record) => sum + (record.runtime.promptBudget.estimatedReductionRatio ?? 0), 0) / withBudgets.length
      : 0;

    return {
      promptCompression: {
        averageReductionRatio,
        tasksWithBudget: withBudgets.length
      },
      runtime: {
        activeTasks: runtimes.filter(record => record.runtime.lifecycleStatus === 'RUNNING').length,
        pausedTasks: runtimes.filter(record => record.runtime.lifecycleStatus === 'PAUSED').length,
        failedTasks: runtimes.filter(record => record.runtime.lifecycleStatus === 'FAILED').length,
        completedTasks: runtimes.filter(record => record.runtime.lifecycleStatus === 'COMPLETED').length
      }
    };
  }
}
