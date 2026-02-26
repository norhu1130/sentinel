import * as Sentry from '@sentry/node';
import { ClanManager } from '../lib/abilities/ClanManager.js';
import { Task, type TaskRunData } from '../lib/schedule/tasks/Task.js';

export class DeleteOrphanClan extends Task {
	public async run(data: TaskRunData) {
		const { guildId, customRoleId } = JSON.parse(data.data!) as { customRoleId: string; guildId: string };

		const logPrefix = `[ORPHAN CLAN @&${customRoleId}]`;
		const tags = { customRoleId, guildId, taskId: String(data.id) };

		Sentry.addBreadcrumb({
			category: 'clan',
			message: `${logPrefix} Starting scheduled orphan clan deletion`,
			level: 'info',
			data: tags,
		});

		this.container.logger.info(`${logPrefix} Executing scheduled orphan clan deletion`);

		try {
			await new ClanManager(customRoleId, guildId).deleteOrphanClan();

			Sentry.addBreadcrumb({
				category: 'clan',
				message: `${logPrefix} Orphan clan deletion completed`,
				level: 'info',
				data: tags,
			});
		} catch (error) {
			Sentry.addBreadcrumb({
				category: 'clan',
				message: `${logPrefix} Orphan clan deletion failed`,
				level: 'error',
				data: { ...tags, error: String(error) },
			});
			Sentry.withScope((scope) => {
				scope.setTags(tags);
				scope.setTag('operation', 'deleteOrphanClan');
				Sentry.captureException(error);
			});
			this.container.logger.error(`${logPrefix} Orphan clan deletion failed:`, error);
		}

		return null;
	}
}
