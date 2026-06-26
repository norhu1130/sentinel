import { ApplyOptions } from '@sapphire/decorators';
import { Events, Listener } from '@sapphire/framework';
import * as Sentry from '@sentry/node';
import type { GuildMember } from 'discord.js';
import { ClanManager } from '../../../lib/abilities/ClanManager.js';
import { recordClanEvent } from '../../../lib/utils/clanHistory.js';
import { LogPrefix } from '../../../lib/utils/logPrefix.js';

@ApplyOptions<Listener.Options>({ event: Events.GuildMemberRemove })
export class GuildMemberRemove extends Listener<typeof Events.GuildMemberRemove> {
	public override async run(member: GuildMember) {
		const logPrefix = `[PREMIUM @${member.id}]`;
		const tags = { userId: member.id, guildId: member.guild.id };

		Sentry.addBreadcrumb({
			category: 'clan',
			message: `${logPrefix} Member left server, starting cleanup`,
			level: 'info',
			data: { ...tags, memberTag: member.user.tag },
		});

		this.container.logger.info(`${LogPrefix.PREMIUM} ${member.user.tag} left the server`, {
			userId: member.id,
			guildId: member.guild.id,
		});

		const clanManager = new ClanManager(member);
		const clan = await clanManager.getClan();
		const customRoleId = await clanManager.getCustomRoleId();

		if (clan) {
			Sentry.addBreadcrumb({
				category: 'clan',
				message: `${logPrefix} Member owns a clan, making it orphan`,
				level: 'info',
				data: { ...tags, customRoleId: clan.customRoleId, channelId: clan.channelId },
			});

			try {
				await clanManager.makeClanOrphan(false, 'Owner left the server');
				Sentry.addBreadcrumb({
					category: 'clan',
					message: `${logPrefix} Clan marked as orphan successfully`,
					level: 'info',
					data: tags,
				});
			} catch (error) {
				Sentry.addBreadcrumb({
					category: 'clan',
					message: `${logPrefix} Failed to make clan orphan`,
					level: 'error',
					data: { ...tags, error: String(error) },
				});
				Sentry.withScope((scope) => {
					scope.setTags(tags);
					scope.setTag('operation', 'premiumMemberRemove');
					scope.setExtra('context', 'makeClanOrphan failed');
					Sentry.captureException(error);
				});
			}
		} else {
			const premiumMember = await this.container.prisma.premiumMember.findFirst({
				where: { guildId: member.guild.id, userId: member.id },
			});

			if (premiumMember) {
				Sentry.addBreadcrumb({
					category: 'clan',
					message: `${logPrefix} Member has premium but no clan, cleaning up roles`,
					level: 'info',
					data: {
						...tags,
						hasCustomRole: Boolean(premiumMember.customRoleId),
						hasGiftedRole: Boolean(premiumMember.giftedRoleToUserId),
					},
				});

				try {
					await ClanManager.deletePremiumRole(premiumMember);
				} catch (error) {
					Sentry.addBreadcrumb({
						category: 'clan',
						message: `${logPrefix} Failed to delete premium role`,
						level: 'error',
						data: { ...tags, error: String(error) },
					});
					Sentry.withScope((scope) => {
						scope.setTags(tags);
						scope.setTag('operation', 'premiumMemberRemove');
						scope.setExtra('context', 'deletePremiumRole failed');
						Sentry.captureException(error);
					});
				}

				try {
					await ClanManager.deleteGiftedRole(premiumMember);
				} catch (error) {
					Sentry.addBreadcrumb({
						category: 'clan',
						message: `${logPrefix} Failed to delete gifted role`,
						level: 'error',
						data: { ...tags, error: String(error) },
					});
					Sentry.withScope((scope) => {
						scope.setTags(tags);
						scope.setTag('operation', 'premiumMemberRemove');
						scope.setExtra('context', 'deleteGiftedRole failed');
						Sentry.captureException(error);
					});
				}
			}
		}

		Sentry.addBreadcrumb({
			category: 'clan',
			message: `${logPrefix} Cleaning up clan memberships`,
			level: 'info',
			data: tags,
		});

		try {
			const clanMemberWhere = {
				clanGuildId: member.guild.id,
				userId: member.id,
				...(customRoleId ? { clanCustomRoleId: { notIn: [customRoleId] } } : {}),
			};

			// Record a MemberLeft event for each clan they were a member of (excluding their own clan,
			// which is handled by the orphan flow above) before the rows are deleted.
			const leavingMemberships = await this.container.prisma.clanMember.findMany({ where: clanMemberWhere });
			for (const membership of leavingMemberships) {
				await recordClanEvent({
					guildId: membership.clanGuildId,
					customRoleId: membership.clanCustomRoleId,
					targetUserId: member.id,
					eventType: 'MemberLeft',
					reason: 'Member left the server',
				});
			}

			const deleteResult = await this.container.prisma.clanMember.deleteMany({ where: clanMemberWhere });

			Sentry.addBreadcrumb({
				category: 'clan',
				message: `${logPrefix} Clan memberships cleaned up`,
				level: 'info',
				data: { ...tags, deletedCount: deleteResult.count },
			});
		} catch (error) {
			Sentry.addBreadcrumb({
				category: 'clan',
				message: `${logPrefix} Failed to clean up clan memberships`,
				level: 'error',
				data: { ...tags, error: String(error) },
			});
			Sentry.withScope((scope) => {
				scope.setTags(tags);
				scope.setTag('operation', 'premiumMemberRemove');
				scope.setExtra('context', 'clanMember deleteMany failed');
				Sentry.captureException(error);
			});
		}

		Sentry.addBreadcrumb({
			category: 'clan',
			message: `${logPrefix} Member removal processing completed`,
			level: 'info',
			data: tags,
		});
	}
}
