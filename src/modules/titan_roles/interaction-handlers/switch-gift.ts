import { ApplyOptions } from '@sapphire/decorators';
import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import type { ButtonInteraction } from 'discord.js';
import { createInfoEmbed } from '../../../lib/utils/createInfoEmbed.js';

export function makeTitanRoleGiftSwitchId(originalUser: string, newUser: string, action: 'cancel' | 'confirm') {
	return `titan-role-switch:${originalUser}:${newUser}:${action}` as const;
}

const thirtyMinutes = 1_000 * 60 * 30;

@ApplyOptions<InteractionHandler.Options>({
	interactionHandlerType: InteractionHandlerTypes.Button,
})
export class SwitchGiftedRole extends InteractionHandler {
	public override parse(interaction: ButtonInteraction) {
		const split = interaction.customId.split(':');

		if (split.length !== 4) {
			return this.none();
		}

		if (split[0] !== 'titan-role-switch') {
			return this.none();
		}

		return this.some({
			originalUser: split[1] as string,
			newUser: split[2] as string,
			action: split[3] as 'cancel' | 'confirm',
		});
	}

	public override async run(interaction: ButtonInteraction<'cached'>, data: InteractionHandler.ParseResult<this>) {
		if (interaction.user.id !== data.originalUser) {
			await interaction.reply({
				embeds: [createInfoEmbed('This maze was not meant for you.')],
				ephemeral: true,
			});

			return;
		}

		if (data.action === 'cancel') {
			await interaction.update({
				components: [],
				embeds: [createInfoEmbed('The switch has been cancelled.')],
			});

			return;
		}

		const guildData = await this.container.prisma.titanGuildRoleConfig.findFirstOrThrow({
			where: { guildId: interaction.guildId },
		});

		const memberData = await this.container.prisma.titanMember.findFirstOrThrow({
			where: { guildId: interaction.guildId, userId: data.originalUser },
		});

		const oldGuildMember = await interaction.guild.members.fetch(memberData.giftedRoleToUserId!).catch(() => null);
		const newGuildMember = await interaction.guild.members.fetch(data.newUser).catch(() => null);

		if (!newGuildMember) {
			await interaction.update({
				components: [],
				embeds: [
					createInfoEmbed('The user you are trying to gift the subscription to is not part of this server!'),
				],
			});

			return;
		}

		if (oldGuildMember) {
			await oldGuildMember.roles.remove(
				guildData.giftableRoleId!,
				`Titan (${interaction.user.tag}) switched gifted role to ${newGuildMember.user.tag}`,
			);
		}

		await newGuildMember.roles.add(
			guildData.giftableRoleId!,
			`Titan (${interaction.user.tag}) switched gifted role from ${oldGuildMember?.user.tag ?? 'nobody'}`,
		);

		await this.container.prisma.titanMember.update({
			where: { guildId_userId: { guildId: interaction.guildId, userId: data.originalUser } },
			data: { giftedRoleToUserId: data.newUser, giftingCooldown: new Date(Date.now() + thirtyMinutes) },
		});

		await interaction.update({
			components: [],
			embeds: [
				createInfoEmbed(
					`The Legend Subscription gift has been switched from ${oldGuildMember?.user.toString() ?? 'nobody'} to ${newGuildMember.user.toString()}.`,
				),
			],
		});
	}
}
