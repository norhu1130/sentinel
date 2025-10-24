import { ApplyOptions } from '@sapphire/decorators';
import { Listener } from '@sapphire/framework';
import { cyanBright, green, magenta } from 'colorette';
import { OAuth2Scopes, PermissionFlagsBits } from 'discord-api-types/v10';
import { loadMediaOnlyChannels } from '../lib/utils/caches/mediaOnlyCache.js';

@ApplyOptions<Listener.Options>({
	once: true,
	event: 'ready',
})
export class ReadyEvent extends Listener {
	public async run() {
		const { client } = this.container;
		const { user, logger } = client;

		logger.info(magenta(`Logged in as ${cyanBright(user!.tag)} (${green(user!.id)})`));

		const invite = client.generateInvite({
			scopes: [OAuth2Scopes.ApplicationsCommands, OAuth2Scopes.Bot],
			permissions: [PermissionFlagsBits.BanMembers, PermissionFlagsBits.ManageMessages],
		});

		logger.info(`  Invite me! ${cyanBright(invite)}`);

		try {
			await client.schedule.init();

			if (!client.schedule.queue.some((task) => task.taskID === 'checkAutoPins')) {
				await client.schedule.add('checkAutoPins', '* * * * *');
			}

			if (!client.schedule.queue.some((task) => task.taskID === 'checkRolesToRemove')) {
				await client.schedule.add('checkRolesToRemove', '* * * * *');
			}

			if (!client.schedule.queue.some((task) => task.taskID === 'checkPendingKickResets')) {
				await client.schedule.add('checkPendingKickResets', '* * * * *');
			}

			if (!client.schedule.queue.some((task) => task.taskID === 'invitePrune')) {
				await client.schedule.add('invitePrune', '*/10 * * * *');
			}

			if (!client.schedule.queue.some((task) => task.taskID === 'UpdateClanDirectory')) {
				await client.schedule.add('UpdateClanDirectory', '*/5 * * * *');
			}
		} catch (error) {
			client.emit('wtf', error);
		}

		await loadMediaOnlyChannels();

		for (const guild of client.guilds.cache.values()) {
			try {
				await guild.members.fetch();
			} catch (error) {
				logger.error(`[ReadyEvent] Failed to fetch members for guild ${guild.name} (${guild.id})`, error);
			}
		}
	}
}
