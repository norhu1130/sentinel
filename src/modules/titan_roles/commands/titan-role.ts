import { Buffer } from 'node:buffer';
import { Subcommand, type SubcommandMappingArray } from '@sapphire/plugin-subcommands';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type RoleEditOptions } from 'discord.js';
import looksSame, { type Color } from 'looks-same';
import magicBytes from 'magic-bytes.js';
import { createInfoEmbed } from '../../../lib/utils/createInfoEmbed.js';
import { makeTitanRoleGiftSwitchId } from '../interaction-handlers/switch-gift.js';

// tolerance will be something that we need to definitely tweak over time. Right now it's pretty loose, you need to be reaaal close to the staff colors to be rejected
const kTolerance = 5;

export class TitanRoleCommand extends Subcommand {
	public subcommandMappings: SubcommandMappingArray = [
		{
			type: 'method',
			name: 'edit',
			chatInputRun: 'editSubcommand',
		},
		{
			type: 'method',
			name: 'toggle',
			chatInputRun: 'toggleSubcommand',
		},
		{
			type: 'method',
			name: 'gift-legend',
			chatInputRun: 'giftRoleSubcommand',
		},
	];

	public async editSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		const guildConfig = await this.container.prisma.titanGuildRoleConfig.findFirst({
			where: { guildId: interaction.guildId },
		});

		if (!guildConfig?.originalTitanRoleId) {
			await interaction.reply({
				embeds: [createInfoEmbed("This server doesn't support custom Titan roles.")],
				ephemeral: true,
			});
			return;
		}

		if (!interaction.member.roles.cache.has(guildConfig.originalTitanRoleId)) {
			await interaction.reply({
				embeds: [createInfoEmbed('You do not have the Titan role.')],
				ephemeral: true,
			});

			return;
		}

		await interaction.deferReply({
			ephemeral: true,
		});

		const titanMember = await this.container.prisma.titanMember.findFirst({
			where: { guildId: interaction.guildId, userId: interaction.user.id },
		});

		const titanRole = interaction.guild.roles.cache.get(guildConfig.originalTitanRoleId) ?? null;
		const oldRole = interaction.guild.roles.cache.get(titanMember?.customRoleId ?? '') ?? null;
		const position = (titanRole?.position ?? 0) + 1;

		const name = interaction.options.getString('name');
		const rawColor = interaction.options.getString('color');
		const iconUrl = interaction.options.getString('icon-url');
		const iconUpload = interaction.options.getAttachment('icon-upload');

		if (!oldRole && !name) {
			await interaction.editReply({
				embeds: [createInfoEmbed('You do not have a custom Titan role. Please provide a name to create one!')],
			});

			return;
		}

		if (iconUpload && iconUrl) {
			await interaction.editReply({
				embeds: [createInfoEmbed('You cannot provide both an icon URL and an icon upload.')],
			});

			return;
		}

		const color = rawColor ? this.parseColor(rawColor) : undefined;

		if (color === null) {
			await interaction.editReply({
				embeds: [createInfoEmbed('Invalid color provided. Please provide a valid hexadecimal color.')],
			});

			return;
		}

		if (color) {
			const staffColors: ColorMatch[] = guildConfig.staffRoles
				.map((id) => {
					const role = interaction.guild.roles.cache.get(id);

					if (!role) {
						return null;
					}

					return {
						color: role.color,
						matched: false,
						roleName: role.name,
					};
				})
				.filter((role) => role !== null) as ColorMatch[];

			this.similarityInColors(color, staffColors);

			if (staffColors.some((data) => data.matched)) {
				this.container.logger.info(
					`Color similarity data:`,
					JSON.stringify({
						userId: interaction.user.id,
						guildId: interaction.guildId,
						staffColors,
						inputColor: color,
					}),
				);

				await interaction.editReply({
					embeds: [
						createInfoEmbed(
							`Your custom Titan role color is too similar to the staff roles. Please choose a different color.`,
						),
					],
				});

				return;
			}
		}

		const roleData: RoleEditOptions = {
			name: name ?? oldRole?.name,
			color: color ?? oldRole?.color,
			hoist: false,
			// Only set position when creating, as this requires moving roles around, which at Valorant's scale means a fuck ton of events sent to everyone :>
			position: oldRole ? undefined : position,
			mentionable: false,
			permissions: [],
			reason: 'Custom Titan role',
		};

		if (iconUrl || iconUpload) {
			const icon = await this.resolveIcon(iconUrl ?? iconUpload?.url);

			if (icon === null) {
				await interaction.editReply({
					embeds: [createInfoEmbed('Invalid icon provided. Please provide a valid PNG or JPEG icon.')],
				});

				return;
			}

			roleData.icon = icon;
		}

		try {
			const newRole = oldRole ? await oldRole.edit(roleData) : await interaction.guild.roles.create(roleData);

			if (!oldRole) {
				await interaction.member.roles.add(newRole.id, 'Setup custom Titan role');
			}

			await this.container.prisma.titanMember.upsert({
				where: { guildId_userId: { guildId: interaction.guildId, userId: interaction.user.id } },
				update: { customRoleId: newRole.id },
				create: {
					guildId: interaction.guildId,
					userId: interaction.user.id,
					customRoleId: newRole.id,
				},
			});

			await interaction.editReply({
				embeds: [
					createInfoEmbed(
						oldRole ?
							`Your custom Titan role has been updated.`
						:	`Your custom Titan role has been created.`,
					),
				],
			});
		} catch (error) {
			this.container.logger.error(`Failed to edit/create custom Titan role`, {
				userId: interaction.user.id,
				guildId: interaction.guildId,
				error,
			});

			await interaction.editReply({
				embeds: [
					createInfoEmbed(
						'I was unable to create/edit your custom Titan role. If this persists, please contact the admins.',
					),
				],
			});
		}
	}

	public async toggleSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		const guildConfig = await this.container.prisma.titanGuildRoleConfig.findFirst({
			where: { guildId: interaction.guildId },
		});

		if (!guildConfig?.originalTitanRoleId) {
			await interaction.reply({
				embeds: [createInfoEmbed("This server doesn't support custom Titan roles.")],
				ephemeral: true,
			});
			return;
		}

		if (!interaction.member.roles.cache.has(guildConfig.originalTitanRoleId)) {
			await interaction.reply({
				embeds: [createInfoEmbed('You do not have the Titan role.')],
				ephemeral: true,
			});
			return;
		}

		const titanMember = await this.container.prisma.titanMember.findFirst({
			where: { guildId: interaction.guildId, userId: interaction.user.id },
		});

		if (!titanMember?.customRoleId) {
			await interaction.reply({
				embeds: [
					createInfoEmbed(
						"You'll need to configure your custom Titan role by running the `/titan-role edit` command first!",
					),
				],
				ephemeral: true,
			});

			return;
		}

		const guildRole = interaction.guild.roles.cache.get(titanMember.customRoleId);

		// Custom role no longer exists
		if (!guildRole) {
			await this.container.prisma.titanMember.update({
				where: { guildId_userId: { guildId: interaction.guildId, userId: interaction.user.id } },
				data: { customRoleId: null },
			});

			await interaction.reply({
				embeds: [
					createInfoEmbed('Your custom Titan role no longer exists. Run `/titan-role edit` to recreate it.'),
				],
				ephemeral: true,
			});

			return;
		}

		try {
			if (interaction.member.roles.cache.has(guildRole.id)) {
				await interaction.member.roles.remove(guildRole, 'Toggled custom Titan role');
				await interaction.reply({
					embeds: [createInfoEmbed('Your custom Titan role has been removed from your profile.')],
					ephemeral: true,
				});
			} else {
				await interaction.member.roles.add(guildRole, 'Toggled custom Titan role');
				await interaction.reply({
					embeds: [createInfoEmbed('Your custom Titan role has been added to your profile.')],
					ephemeral: true,
				});
			}
		} catch (error) {
			this.container.logger.error(`Failed to toggle custom Titan role`, {
				userId: interaction.user.id,
				guildId: interaction.guildId,
				error,
			});

			await interaction.reply({
				embeds: [
					createInfoEmbed(
						'I was unable to toggle your custom Titan role. If this persists, please contact the admins.',
					),
				],
				ephemeral: true,
			});
		}
	}

	public async giftRoleSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		const guildConfig = await this.container.prisma.titanGuildRoleConfig.findFirst({
			where: { guildId: interaction.guildId },
		});

		if (!guildConfig?.giftableRoleId || !guildConfig?.originalTitanRoleId) {
			await interaction.reply({
				embeds: [createInfoEmbed("This server doesn't support gifting the Legends Subscription roles.")],
				ephemeral: true,
			});

			return;
		}

		if (!interaction.member.roles.cache.has(guildConfig.originalTitanRoleId)) {
			await interaction.reply({
				embeds: [createInfoEmbed('You do not have the Titan role.')],
				ephemeral: true,
			});

			return;
		}

		const titanMember = await this.container.prisma.titanMember.findFirst({
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

		// If they haven't gifted a role before, we can just gift it
		if (!titanMember?.giftedRoleToUserId) {
			try {
				await targetMember.roles.add(guildConfig.giftableRoleId, `Gifted by a Titan (${interaction.user.tag})`);
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

			await this.container.prisma.titanMember.upsert({
				where: { guildId_userId: { guildId: interaction.guildId, userId: interaction.user.id } },
				update: { giftedRoleToUserId: user.id },
				create: { guildId: interaction.guildId, userId: interaction.user.id, giftedRoleToUserId: user.id },
			});

			await interaction.reply({
				embeds: [createInfoEmbed(`You have successfully gifted a Legend Subscription to ${user.toString()}.`)],
				ephemeral: true,
			});

			return;
		}

		const previousGiftedMember = await interaction.guild.members
			.fetch(titanMember.giftedRoleToUserId)
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
						.setCustomId(makeTitanRoleGiftSwitchId(interaction.user.id, targetMember.id, 'confirm'))
						.setStyle(ButtonStyle.Success)
						.setLabel('Confirm')
						.setEmoji('✅'),

					new ButtonBuilder()
						.setCustomId(makeTitanRoleGiftSwitchId(interaction.user.id, targetMember.id, 'cancel'))
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
				.setDescription('Manage your custom Titan role.')
				.setDMPermission(false)
				.addSubcommand((subcommand) =>
					subcommand
						.setName('edit')
						.setDescription('Edits your custom Titan role.')
						.addStringOption((name) =>
							name
								.setName('name')
								.setDescription('The name of the custom role')
								.setMinLength(1)
								.setMaxLength(100),
						)
						.addStringOption((color) =>
							color
								.setName('color')
								.setDescription('The hexadecimal color of the custom role (#FFFFFF format)'),
						)
						.addAttachmentOption((icon) =>
							icon
								.setName('icon-upload')
								.setDescription('The icon for the custom role (takes precedence over icon-url)'),
						)
						.addStringOption((icon) =>
							icon.setName('icon-url').setDescription('The URL of the icon for the custom role'),
						),
				)
				.addSubcommand((subcommand) =>
					subcommand.setName('toggle').setDescription('Toggles the visibility of your custom Titan role.'),
				)
				.addSubcommand((subcommand) =>
					subcommand
						.setName('gift-legend')
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

	private parseColor(raw: string) {
		let numericParse: number | null = null;

		if (raw.startsWith('#')) {
			numericParse = Number.parseInt(raw.slice(1), 16);
		} else if (raw.startsWith('0x')) {
			numericParse = Number.parseInt(raw, 16);
		}

		if (numericParse === null || Number.isNaN(numericParse)) {
			return null;
		}

		if (numericParse < 0x000000 || numericParse > 0xffffff) {
			return null;
		}

		return numericParse;
	}

	private async resolveIcon(url?: string) {
		if (!url) {
			return null;
		}

		this.container.logger.info(`[TITAN] Trying to resolve icon for custom Titan role`, { url });

		let res: Response;

		try {
			res = await fetch(url);
		} catch (error) {
			this.container.logger.warn(`Failed to fetch icon for custom Titan role`, {
				url,
				error,
			});
			// Invalid URLs or network errors, f
			return null;
		}

		if (!res.ok) {
			this.container.logger.warn(`Failed to fetch icon for custom Titan role`, {
				url,
				status: res.status,
				statusText: res.statusText,
				text: await res.text(),
			});

			return null;
		}

		const buffer = await res.arrayBuffer();
		const uint8 = Buffer.from(buffer);

		const exts = magicBytes.filetypeextension(uint8);

		if (exts.includes('png') || exts.includes('jpg') || exts.includes('jpeg')) {
			return uint8;
		}

		this.container.logger.info(`[TITAN] Invalid icon format for custom Titan role`, { url, exts });

		return null;
	}

	/* eslint-disable id-length */
	private similarityInColors(input: number, forbiddenOnes: ColorMatch[]) {
		// Construct RGB objects for each color
		const inputRGB: Color = {
			R: (input & 0xff0000) >> 16,
			G: (input & 0x00ff00) >> 8,
			B: input & 0x0000ff,
		};

		for (const data of forbiddenOnes) {
			const forbiddenRGB: Color = {
				R: (data.color & 0xff0000) >> 16,
				G: (data.color & 0x00ff00) >> 8,
				B: data.color & 0x0000ff,
			};

			const similarity = looksSame.colors(inputRGB, forbiddenRGB, { tolerance: kTolerance });

			if (similarity) {
				data.matched = true;
			}
		}
	}
	/* eslint-enable id-length */
}

interface ColorMatch {
	color: number;
	matched: boolean;
	roleName: string;
}
