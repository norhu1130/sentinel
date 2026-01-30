import { ApplyOptions } from '@sapphire/decorators';
import { Events, Listener } from '@sapphire/framework';
import * as Sentry from '@sentry/node';
import type { GuildMember } from 'discord.js';
import { ClanManager } from '../../../lib/abilities/ClanManager.js';
import { MemberAbilities } from '../../../lib/abilities/MemberAbilities.js';
import { ensureFullMember } from '../../../lib/utils.js';

@ApplyOptions<Listener.Options>({ event: Events.GuildMemberUpdate })
export class PremiumUnsubscribe extends Listener<typeof Events.GuildMemberUpdate> {
	public override async run(oldMember: GuildMember, newMember: GuildMember) {
		await ensureFullMember(oldMember);
		await ensureFullMember(newMember);

		const oldMemberAbilities = new MemberAbilities(oldMember);
		const newMemberAbilities = new MemberAbilities(newMember);

		await oldMemberAbilities.computeAbilities();
		await newMemberAbilities.computeAbilities();

		if (oldMemberAbilities.hasNone() || oldMemberAbilities.hasEqualAbilities(newMemberAbilities)) {
			return;
		}

		const logPrefix = `[PREMIUM @${newMember.id}]`;
		const tags = { userId: newMember.id, guildId: newMember.guild.id };

		Sentry.addBreadcrumb({
			category: 'clan',
			message: `${logPrefix} Member lost some premium abilities`,
			level: 'info',
			data: { ...tags, memberTag: newMember.user.tag },
		});

		this.container.logger.info(`[PREMIUM] ${newMember.user.tag} has lost some premium abilities`, {
			userId: newMember.id,
			guildId: newMember.guild.id,
		});

		const clanManager = new ClanManager(oldMember);
		const clan = await clanManager.getClan();
		const canNoLongerCreateClan = !newMemberAbilities.hasAbility('canCreateClan');
		const canNoLongerCreateCustomRole =
			oldMemberAbilities.hasAbility('canCreateCustomRole') &&
			!newMemberAbilities.hasAbility('canCreateCustomRole');
		const canNoLongerGiftLegend =
			oldMemberAbilities.hasAbility('canGiftLegend') && !newMemberAbilities.hasAbility('canGiftLegend');

		Sentry.addBreadcrumb({
			category: 'clan',
			message: `${logPrefix} Ability changes detected`,
			level: 'info',
			data: {
				...tags,
				canNoLongerCreateClan,
				canNoLongerCreateCustomRole,
				canNoLongerGiftLegend,
				hasClan: Boolean(clan),
			},
		});

		const premiumMember = await this.container.prisma.premiumMember.findFirst({
			where: { guildId: newMember.guild.id, userId: newMember.id },
		});

		if (canNoLongerCreateClan && clan) {
			Sentry.addBreadcrumb({
				category: 'clan',
				message: `${logPrefix} Member can no longer create clan, making existing clan orphan`,
				level: 'info',
				data: { ...tags, customRoleId: clan.customRoleId },
			});

			try {
				await clanManager.makeClanOrphan();
				Sentry.addBreadcrumb({
					category: 'clan',
					message: `${logPrefix} Clan marked as orphan successfully`,
					level: 'info',
					data: tags,
				});
			} catch (error) {
				Sentry.addBreadcrumb({
					category: 'clan',
					message: `${logPrefix} Failed to make clan orphan after ability loss`,
					level: 'error',
					data: { ...tags, error: String(error) },
				});
				Sentry.withScope((scope) => {
					scope.setTags(tags);
					scope.setTag('operation', 'premiumUnsubscribe');
					scope.setExtra('context', 'makeClanOrphan failed after ability loss');
					scope.setExtra('abilityChanges', {
						canNoLongerCreateClan,
						canNoLongerCreateCustomRole,
						canNoLongerGiftLegend,
					});
					Sentry.captureException(error);
				});
			}
		} else if (premiumMember) {
			if (canNoLongerCreateCustomRole) {
				Sentry.addBreadcrumb({
					category: 'clan',
					message: `${logPrefix} Member can no longer create custom role, deleting premium role`,
					level: 'info',
					data: { ...tags, customRoleId: premiumMember.customRoleId },
				});

				try {
					await ClanManager.deletePremiumRole(premiumMember);
					Sentry.addBreadcrumb({
						category: 'clan',
						message: `${logPrefix} Premium role deleted successfully`,
						level: 'info',
						data: tags,
					});
				} catch (error) {
					Sentry.addBreadcrumb({
						category: 'clan',
						message: `${logPrefix} Failed to delete premium role after ability loss`,
						level: 'error',
						data: { ...tags, error: String(error) },
					});
					Sentry.withScope((scope) => {
						scope.setTags(tags);
						scope.setTag('operation', 'premiumUnsubscribe');
						scope.setExtra('context', 'deletePremiumRole failed');
						Sentry.captureException(error);
					});
				}
			}

			if (canNoLongerGiftLegend) {
				Sentry.addBreadcrumb({
					category: 'clan',
					message: `${logPrefix} Member can no longer gift legend, removing gifted role`,
					level: 'info',
					data: { ...tags, giftedToUserId: premiumMember.giftedRoleToUserId },
				});

				try {
					await ClanManager.deleteGiftedRole(premiumMember);
					Sentry.addBreadcrumb({
						category: 'clan',
						message: `${logPrefix} Gifted role deleted successfully`,
						level: 'info',
						data: tags,
					});
				} catch (error) {
					Sentry.addBreadcrumb({
						category: 'clan',
						message: `${logPrefix} Failed to delete gifted role after ability loss`,
						level: 'error',
						data: { ...tags, error: String(error) },
					});
					Sentry.withScope((scope) => {
						scope.setTags(tags);
						scope.setTag('operation', 'premiumUnsubscribe');
						scope.setExtra('context', 'deleteGiftedRole failed');
						Sentry.captureException(error);
					});
				}
			}
		}

		Sentry.addBreadcrumb({
			category: 'clan',
			message: `${logPrefix} Premium unsubscribe processing completed`,
			level: 'info',
			data: tags,
		});
	}
}
