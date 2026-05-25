import { ApplyOptions } from '@sapphire/decorators';
import { Listener } from '@sapphire/framework';
import * as Sentry from '@sentry/node';
import { cyanBright, green, magenta } from 'colorette';
import { OAuth2Scopes, PermissionFlagsBits } from 'discord-api-types/v10';
import { loadMediaOnlyChannels } from '../lib/utils/caches/mediaOnlyCache.js';
import { LogPrefix } from '../lib/utils/logPrefix.js';

declare module 'discord.js' {
	interface ClientEvents {
		membersCached: [];
	}
}

@ApplyOptions<Listener.Options>({
	once: true,
	event: 'clientReady',
})
export class ClientReadyEvent extends Listener {
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

			const premiumAbilityCheckData = JSON.stringify({ fixMode: 'fix-all' });
			const existingPremiumAbilityCheck = client.schedule.queue.find(
				(task) => task.taskID === 'checkPremiumMemberAbilities',
			);

			if (!existingPremiumAbilityCheck) {
				await client.schedule.add('checkPremiumMemberAbilities', '0 10 * * *', premiumAbilityCheckData);
			} else if (existingPremiumAbilityCheck.data !== premiumAbilityCheckData) {
				await client.schedule.remove(existingPremiumAbilityCheck);
				await client.schedule.add('checkPremiumMemberAbilities', '0 10 * * *', premiumAbilityCheckData);
			}
		} catch (error) {
			client.emit('wtf', error);
		}

		await loadMediaOnlyChannels();

		// Fetch all members for all guilds once, then emit event for other listeners
		const guilds = [...client.guilds.cache.values()];
		const totalGuilds = guilds.length;

		logger.info(`${LogPrefix.MEMBER_CACHE} Starting member fetch for ${totalGuilds} guild(s)...`);
		Sentry.addBreadcrumb({
			category: 'startup',
			message: `Starting member fetch for ${totalGuilds} guilds`,
			level: 'info',
		});

		let successCount = 0;
		let failCount = 0;
		let totalMembersCached = 0;

		for (const [index, guild] of guilds.entries()) {
			const progress = `[${index + 1}/${totalGuilds}]`;
			const remaining = totalGuilds - index - 1;

			try {
				logger.info(
					`${LogPrefix.MEMBER_CACHE} ${progress} Fetching members for "${guild.name}" (${guild.id})...`,
				);
				Sentry.addBreadcrumb({
					category: 'startup',
					message: `Fetching members for guild ${guild.name}`,
					level: 'info',
					data: { guildId: guild.id, guildName: guild.name, progress: `${index + 1}/${totalGuilds}` },
				});

				await guild.members.fetch();
				successCount++;

				const memberCount = guild.members.cache.size;
				totalMembersCached += memberCount;

				logger.info(
					`${LogPrefix.MEMBER_CACHE} ${progress} Fetched ${memberCount.toLocaleString()} members for "${guild.name}"` +
						(remaining > 0 ? ` (${remaining} guild(s) remaining)` : ''),
				);
				Sentry.addBreadcrumb({
					category: 'startup',
					message: `Fetched ${memberCount} members for guild ${guild.name}`,
					level: 'info',
					data: { guildId: guild.id, memberCount, totalMembersCached },
				});
			} catch (error) {
				failCount++;
				logger.error(
					`${LogPrefix.MEMBER_CACHE} ${progress} FAILED to fetch members for "${guild.name}" (${guild.id}):`,
					error,
				);
				Sentry.addBreadcrumb({
					category: 'startup',
					message: `Failed to fetch members for guild ${guild.name}`,
					level: 'error',
					data: { guildId: guild.id, error: String(error) },
				});
				Sentry.withScope((scope) => {
					scope.setTag('guildId', guild.id);
					scope.setTag('operation', 'startup-member-fetch');
					Sentry.captureException(error);
				});
			}
		}

		logger.info(
			`${LogPrefix.MEMBER_CACHE} Complete! Cached ${totalMembersCached.toLocaleString()} members across ${successCount} guild(s)` +
				(failCount > 0 ? ` (${failCount} failed)` : '') +
				'. Emitting membersCached event.',
		);
		Sentry.addBreadcrumb({
			category: 'startup',
			message: `Member fetch complete, emitting membersCached`,
			level: 'info',
			data: { successCount, failCount, totalMembersCached },
		});

		// Emit custom event so other listeners know members are cached
		client.emit('membersCached');
	}
}
