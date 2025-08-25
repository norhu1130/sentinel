import { ApplyOptions } from '@sapphire/decorators';
import { Events, Listener } from '@sapphire/framework';
import type { GuildMember } from 'discord.js';
import { ClanManager } from '../../../lib/abilities/ClanManager.js';
import { MemberAbilities } from '../../../lib/abilities/MemberAbilities.js';

@ApplyOptions<Listener.Options>({ event: Events.GuildMemberUpdate })
export class PremiumUnsubscribe extends Listener<typeof Events.GuildMemberUpdate> {
	public override async run(oldMember: GuildMember, newMember: GuildMember) {
		const guildConfig = await this.container.prisma.premiumGuildRoleConfig.findFirst({
			where: { guildId: newMember.guild.id },
		});

		const oldMemberAbilities = new MemberAbilities(oldMember);
		const newMemberAbilities = new MemberAbilities(newMember);

		await oldMemberAbilities.computeAbilities();
		await newMemberAbilities.computeAbilities();

		if (oldMemberAbilities.hasNone() || oldMemberAbilities.hasEqualAbilities(newMemberAbilities)) {
			return;
		}

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

		const premiumMember = await this.container.prisma.premiumMember.findFirst({
			where: { guildId: newMember.guild.id, userId: newMember.id },
		});

		// If user has a clan, we put a cooldown on everything
		// Once the cooldown is over, if the user is still not back
		// The clan will be deleted, as well as everything that's handled in the "else" block
		if (canNoLongerCreateClan && clan) {
			await clanManager.makeClanOrphan();
		} else {
			if (canNoLongerCreateCustomRole && premiumMember?.customRoleId) {
				try {
					await newMember.guild.roles.delete(
						premiumMember.customRoleId,
						'Lost custom premium role due to losing premium role',
					);
				} catch (error) {
					this.container.logger.error(`[PREMIUM] Failed to delete custom premium role`, {
						userId: newMember.id,
						guildId: newMember.guild.id,
						error,
					});
				}

				await this.container.prisma.premiumMember.update({
					where: { guildId_userId: { guildId: newMember.guild.id, userId: newMember.id } },
					data: { customRoleId: null },
				});
			}

			if (canNoLongerGiftLegend && guildConfig?.legendRoleId && premiumMember?.giftedRoleToUserId) {
				const giftedUser = await newMember.guild.members.fetch(premiumMember.giftedRoleToUserId).catch(() => null);

				if (giftedUser) {
					try {
						await giftedUser.roles.remove(
							guildConfig.legendRoleId,
							'Original premium member lost premium role',
						);
					} catch (error) {
						this.container.logger.error(`[PREMIUM] Failed to remove gifted role`, {
							userId: giftedUser.id,
							guildId: newMember.guild.id,
							giftedBy: newMember.id,
							error,
						});
					}
				}

				await this.container.prisma.premiumMember.update({
					where: { guildId_userId: { guildId: newMember.guild.id, userId: newMember.id } },
					data: { giftedRoleToUserId: null },
				});
			}
		}
	}
}
