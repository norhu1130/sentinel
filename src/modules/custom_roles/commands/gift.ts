import { Subcommand, type SubcommandMappingArray } from '@sapphire/plugin-subcommands';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, time, TimestampStyles } from 'discord.js';
import { MemberAbilities } from '../../../lib/abilities/MemberAbilities.js';
import { RoleAbilitiesCalculator } from '../../../lib/abilities/RoleAbilities.js';
import { createInfoEmbed } from '../../../lib/utils/createEmbed.js';
import { makePremiumRoleGiftSwitchId } from '../interaction-handlers/switch-gift.js';

const thirtyMinutes = 1_000 * 60 * 30;

export class GiftCommand extends Subcommand {
	public subcommandMappings: SubcommandMappingArray = [
		{
			type: 'method',
			name: 'legend',
			chatInputRun: 'legendSubcommand',
		},
	];

	public async legendSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		const guildConfig = await this.container.prisma.premiumGuildRoleConfig.findFirst({
			where: { guildId: interaction.guildId },
		});

		const roleAbilitiesCalculator = new RoleAbilitiesCalculator(interaction.guild.id);
		const memberAbilities = new MemberAbilities(interaction.member);

		await roleAbilitiesCalculator.computeList();
		await memberAbilities.computeAbilities();

		if (!guildConfig?.legendRoleId || roleAbilitiesCalculator.getPremiumRoleIds('canGiftLegend').length < 1) {
			await interaction.reply({
				embeds: [createInfoEmbed(`This server doesn't support gifting the Legends Subscription role.`)],
				ephemeral: true,
			});
			return;
		}

		if (!memberAbilities.hasAbility('canGiftLegend')) {
			await interaction.reply({
				embeds: [createInfoEmbed('You do not have the ability to gift the Legends Subscription role.')],
				ephemeral: true,
			});

			return;
		}

		const privilegedMember = await this.container.prisma.premiumMember.findFirst({
			where: { guildId: interaction.guildId, userId: interaction.user.id },
		});

		const user = interaction.options.getUser('user', true);
		const targetMember = await interaction.guild.members.fetch(user.id).catch(() => null);

		if (!targetMember) {
			await interaction.reply({
				embeds: [createInfoEmbed('I was unable to find the user you mentioned in this server.')],
				ephemeral: true,
			});

			return;
		}

		if (privilegedMember?.giftingCooldown) {
			const now = Date.now();

			if (now < privilegedMember.giftingCooldown.getTime()) {
				await interaction.reply({
					embeds: [
						createInfoEmbed(
							`You'll be able to gift or transfer the Legend Subscription ${time(privilegedMember.giftingCooldown, TimestampStyles.RelativeTime)}`,
						),
					],
					ephemeral: true,
				});

				return;
			}
		}

		// If they haven't gifted a role before, we can just gift it
		if (!privilegedMember?.giftedRoleToUserId) {
			try {
				await targetMember.roles.add(
					guildConfig.legendRoleId,
					`Gifted by a premium user (${interaction.user.tag})`,
				);
			} catch (error) {
				this.container.logger.error(`Failed to gift role to user`, {
					userId: interaction.user.id,
					guildId: interaction.guildId,
					error,
				});

				await interaction.reply({
					embeds: [
						createInfoEmbed(
							'I was unable to gift the role to the user. Please try again later, and if this error persists, contact the admins.',
						),
					],
					ephemeral: true,
				});

				return;
			}

			await this.container.prisma.premiumMember.upsert({
				where: { guildId_userId: { guildId: interaction.guildId, userId: interaction.user.id } },
				update: { giftedRoleToUserId: user.id, giftingCooldown: new Date(Date.now() + thirtyMinutes) },
				create: {
					guildId: interaction.guildId,
					userId: interaction.user.id,
					giftedRoleToUserId: user.id,
					giftingCooldown: new Date(Date.now() + thirtyMinutes),
				},
			});

			await interaction.reply({
				embeds: [
					createInfoEmbed(
						`You have successfully gifted a Legend Subscription to ${user.toString()}.\n\nUse the command again to switch the Legend role to a different user. You can only gift one Legend role at a time.`,
					),
				],
				ephemeral: true,
			});

			return;
		}

		const previousGiftedMember = await interaction.guild.members
			.fetch(privilegedMember.giftedRoleToUserId)
			.catch(() => null);

		if (previousGiftedMember?.id === user.id) {
			await interaction.reply({
				embeds: [createInfoEmbed('You have already gifted the Legend Subscription to this user.')],
				ephemeral: true,
			});

			return;
		}

		await interaction.reply({
			embeds: [
				createInfoEmbed(
					`Are you sure you want to switch the gifted subscription from ${previousGiftedMember?.user.toString() ?? 'nobody'} to ${user.toString()}?`,
				),
			],
			ephemeral: true,
			components: [
				new ActionRowBuilder<ButtonBuilder>().addComponents(
					new ButtonBuilder()
						.setCustomId(makePremiumRoleGiftSwitchId(interaction.user.id, targetMember.id, 'confirm'))
						.setStyle(ButtonStyle.Success)
						.setLabel('Confirm')
						.setEmoji('✅'),

					new ButtonBuilder()
						.setCustomId(makePremiumRoleGiftSwitchId(interaction.user.id, targetMember.id, 'cancel'))
						.setStyle(ButtonStyle.Secondary)
						.setLabel('Cancel')
						.setEmoji('❌'),
				),
			],
		});
	}

	public override registerApplicationCommands(registry: Subcommand.Registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName(this.name)
				.setDescription('Gift to other members.')
				.setDMPermission(false)
				.addSubcommand((subcommand) =>
					subcommand
						.setName('legend')
						.setDescription('Gifts a Legend Subscription to someone')
						.addUserOption((user) =>
							user
								.setName('user')
								.setDescription('The user to gift the subscription to')
								.setRequired(true),
						),
				),
		);
	}
}
