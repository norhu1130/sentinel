import { ApplyOptions } from '@sapphire/decorators';
import { Events, Listener } from '@sapphire/framework';
import type { GuildMember } from 'discord.js';
import { ClanManager } from '../../../lib/abilities/ClanManager.js';

@ApplyOptions<Listener.Options>({ event: Events.GuildMemberRemove })
export class GuildMemberRemove extends Listener<typeof Events.GuildMemberRemove> {
	public override async run(member: GuildMember) {
		const guildConfig = await this.container.prisma.premiumGuildRoleConfig.findFirst({
			where: { guildId: member.guild.id },
		});

		this.container.logger.info(`[PREMIUM] ${member.user.tag} left the server`, {
			userId: member.id,
			guildId: member.guild.id,
		});

		const clanManager = new ClanManager(member);
		await clanManager.deleteClan();

		const premiumMember = await this.container.prisma.premiumMember.findFirst({
			where: { guildId: member.guild.id, userId: member.id },
		});

		if (premiumMember?.customRoleId) {
			try {
				await member.guild.roles.delete(
					premiumMember.customRoleId,
					'Member who created custom role left the server',
				);
			} catch (error) {
				this.container.logger.error(`[PREMIUM] Failed to delete custom premium role`, {
					userId: member.id,
					guildId: member.guild.id,
					error,
				});
			}

			await this.container.prisma.premiumMember.update({
				where: { guildId_userId: { guildId: member.guild.id, userId: member.id } },
				data: { customRoleId: null },
			});
		}

		if (guildConfig?.legendRoleId && premiumMember?.giftedRoleToUserId) {
			const giftedUser = await member.guild.members.fetch(premiumMember.giftedRoleToUserId).catch(() => null);

			if (giftedUser) {
				try {
					await giftedUser.roles.remove(guildConfig.legendRoleId, 'Original premium member left server');
				} catch (error) {
					this.container.logger.error(`[PREMIUM] Failed to remove gifted role`, {
						userId: giftedUser.id,
						guildId: member.guild.id,
						giftedBy: member.id,
						error,
					});
				}
			}

			await this.container.prisma.premiumMember.update({
				where: { guildId_userId: { guildId: member.guild.id, userId: member.id } },
				data: { giftedRoleToUserId: null },
			});
		}

		await this.container.prisma.clanMember.deleteMany({
			where: { clanGuildId: member.guild.id, userId: member.id },
		});
	}
}
