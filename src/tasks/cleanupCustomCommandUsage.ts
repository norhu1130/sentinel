import { Task } from '../lib/schedule/tasks/Task.js';
import { LogPrefix } from '../lib/utils/logPrefix.js';

/**
 * How long custom command usage records are kept before being pruned, to bound database growth.
 */
export const CUSTOM_COMMAND_USAGE_RETENTION_DAYS = 30;

export class CleanupCustomCommandUsage extends Task {
	public async run() {
		const cutoff = new Date(Date.now() - CUSTOM_COMMAND_USAGE_RETENTION_DAYS * 24 * 60 * 60 * 1_000);

		const { count } = await this.container.prisma.customCommandUsage.deleteMany({
			where: { usedAt: { lt: cutoff } },
		});

		if (count > 0) {
			this.container.logger.info(
				`${LogPrefix.CUSTOM_COMMAND} Pruned ${count} custom command usage record(s) older than ${CUSTOM_COMMAND_USAGE_RETENTION_DAYS} days`,
			);
		}

		return null;
	}
}
