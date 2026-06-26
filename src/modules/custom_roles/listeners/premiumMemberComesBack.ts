import { ApplyOptions } from '@sapphire/decorators';
import { Events, Listener } from '@sapphire/framework';
import * as Sentry from '@sentry/node';
import type { GuildMember } from 'discord.js';
import { ClanManager } from '../../../lib/abilities/ClanManager.js';
import { LogPrefix } from '../../../lib/utils/logPrefix.js';
import { ensureFullMember } from '../../../lib/utils.js';

@ApplyOptions<Listener.Options>({ event: Events.GuildMemberAdd })
export class GuildMemberComesBack extends Listener<typeof Events.GuildMemberAdd> {
	public override async run(member: GuildMember) {
		await ensureFullMember(member);

		const clanManager = new ClanManager(member);
		const clan = await clanManager.getClan();

		if (!clan) {
			return;
		}

		const logPrefix = `[PREMIUM @${member.id}]`;
		const tags = { userId: member.id, guildId: member.guild.id, customRoleId: clan.customRoleId };

		Sentry.addBreadcrumb({
			category: 'clan',
			message: `${logPrefix} Member with orphaned clan has returned`,
			level: 'info',
			data: { ...tags, memberTag: member.user.tag, deletionTaskId: clan.deletionTaskId },
		});

		this.container.logger.info(`${LogPrefix.PREMIUM} ${member.user.tag} has come back to the server`, {
			userId: member.id,
			guildId: member.guild.id,
		});

		try {
			await clanManager.makeClanNotOrphan({ actorUserId: member.id, reason: 'Owner returned to the server' });
			Sentry.addBreadcrumb({
				category: 'clan',
				message: `${logPrefix} Clan restored successfully`,
				level: 'info',
				data: tags,
			});
		} catch (error) {
			Sentry.addBreadcrumb({
				category: 'clan',
				message: `${logPrefix} Failed to restore clan after member return`,
				level: 'error',
				data: { ...tags, error: String(error) },
			});
			Sentry.withScope((scope) => {
				scope.setTags(tags);
				scope.setTag('operation', 'premiumMemberComesBack');
				scope.setExtra('context', 'makeClanNotOrphan failed');
				scope.setExtra('clan', { deletionTaskId: clan.deletionTaskId, channelId: clan.channelId });
				Sentry.captureException(error);
			});
		}
	}
}
