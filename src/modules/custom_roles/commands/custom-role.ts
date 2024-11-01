import { Buffer } from 'node:buffer';
import { Subcommand, type SubcommandMappingArray } from '@sapphire/plugin-subcommands';
import { type RoleEditOptions } from 'discord.js';
import looksSame, { type Color } from 'looks-same';
import magicBytes from 'magic-bytes.js';
import { MemberAbilities } from '../../../lib/abilities/MemberAbilities.js';
import { RoleAbilitiesCalculator } from '../../../lib/abilities/RoleAbilities.js';
import { createInfoEmbed } from '../../../lib/utils/createEmbed.js';

// tolerance will be something that we need to definitely tweak over time. Right now it's pretty loose, you need to be reaaal close to the staff colors to be rejected
const kTolerance = 2.5;

const forbiddenColors = (): ColorMatch[] => [
	{
		color: 0xffffff,
		matched: false,
		roleName: 'Purest day',
	},
	{
		color: 0x000000,
		matched: false,
		roleName: 'Darkest night',
	},
];

export class CustomRoleCommand extends Subcommand {
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
	];

	public async editSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		const guildConfig = await this.container.prisma.premiumGuildRoleConfig.findFirst({
			where: { guildId: interaction.guildId },
		});

		const roleAbilitiesCalculator = new RoleAbilitiesCalculator(interaction.guildId);
		const memberAbilities = new MemberAbilities(interaction.member);

		await roleAbilitiesCalculator.computeList();
		await memberAbilities.computeAbilities();

		const premiumRoleIds = roleAbilitiesCalculator.getPremiumRoleIds('canCreateCustomRole');

		if (premiumRoleIds.length < 1) {
			await interaction.reply({
				embeds: [createInfoEmbed("This server doesn't support premium custom roles.")],
				ephemeral: true,
			});
			return;
		}

		if (!memberAbilities.hasAbility('canCreateCustomRole')) {
			await interaction.reply({
				embeds: [createInfoEmbed('You do not have the ability to create a custom role.')],
				ephemeral: true,
			});

			return;
		}

		await interaction.deferReply({
			ephemeral: true,
		});

		const premiumMember = await this.container.prisma.premiumMember.findFirst({
			where: { guildId: interaction.guildId, userId: interaction.user.id },
		});

		const premiumRoles = [...interaction.guild.roles.cache.values()].filter(
			role => premiumRoleIds.includes(role.id)
		);
		const lowestPremiumRole = premiumRoles.reduce(
			(role, lowestRole) => role.position < lowestRole.position ? role : lowestRole, premiumRoles[0]
		);

		const positionRole = interaction.guild.roles.cache.get(guildConfig?.startingPositionRoleId ?? '') ?? null;
		const oldRole = interaction.guild.roles.cache.get(premiumMember?.customRoleId ?? '') ?? null;
		const position = (positionRole?.position ?? lowestPremiumRole?.position ?? 0) + 1;

		const name = interaction.options.getString('name');
		const rawColor = interaction.options.getString('color');
		const iconUrl = interaction.options.getString('icon-url');
		const iconUpload = interaction.options.getAttachment('icon-upload');

		if (!oldRole && !name) {
			await interaction.editReply({
				embeds: [createInfoEmbed('You do not have a premium custom role. Please provide a name to create one!')],
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
			const staffColors: ColorMatch[] = (
				guildConfig?.staffRoles
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
					.filter((role) => role !== null) as ColorMatch[] ?? []
			).concat(forbiddenColors());

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
							`Your premium custom role color is too similar to the staff roles. Please choose a different color.`,
						),
					],
				});

				return;
			}
		}

		if (name) {
			const forbiddenPatterns = await this.container.prisma.forbiddenRoleName.findMany({
				where: { guildId: interaction.guildId },
			});

			for (const { processedPattern, rawPattern } of forbiddenPatterns) {
				const regex = new RegExp(processedPattern, 'i');

				if (regex.test(name)) {
					this.container.logger.info(`Forbidden role name used`, {
						userId: interaction.user.id,
						guildId: interaction.guildId,
						roleName: name,
						processedPattern,
						rawPattern,
					});

					await interaction.editReply({
						embeds: [
							createInfoEmbed('The name you provided is forbidden. Please choose a different name.'),
						],
					});

					return;
				}
			}
		}

		const roleData: RoleEditOptions = {
			name: name ?? oldRole?.name,
			color: color ?? oldRole?.color,
			hoist: true,
			// Only set position when creating, as this requires moving roles around, which at Valorant's scale means a fuck ton of events sent to everyone :>
			position: oldRole ? undefined : position,
			mentionable: false,
			permissions: [],
			reason: 'Premium custom role',
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
				await interaction.member.roles.add(newRole.id, 'Setup premium custom role');
			}

			await this.container.prisma.premiumMember.upsert({
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
							`Your premium custom role has been updated.`
						:	`Your premium custom role has been created.`,
					),
				],
			});
		} catch (error) {
			this.container.logger.error(`Failed to edit/create premium custom role`, {
				userId: interaction.user.id,
				guildId: interaction.guildId,
				error,
			});

			await interaction.editReply({
				embeds: [
					createInfoEmbed(
						'I was unable to create/edit your premium custom role. If this persists, please contact the admins.',
					),
				],
			});
		}
	}

	public async toggleSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		const roleAbilitiesCalculator = new RoleAbilitiesCalculator(interaction.guild.id);
		const memberAbilities = new MemberAbilities(interaction.member);

		await roleAbilitiesCalculator.computeList();
		await memberAbilities.computeAbilities();

		if (roleAbilitiesCalculator.getPremiumRoleIds('canCreateCustomRole').length < 1) {
			await interaction.reply({
				embeds: [createInfoEmbed("This server doesn't support premium custom roles.")],
				ephemeral: true,
			});

			return;
		}

		if (!memberAbilities.hasAbility('canCreateCustomRole')) {
			await interaction.reply({
				embeds: [createInfoEmbed('You do not have the ability to create a custom role.')],
				ephemeral: true,
			});

			return;
		}

		const premiumMember = await this.container.prisma.premiumMember.findFirst({
			where: { guildId: interaction.guildId, userId: interaction.user.id },
		});

		if (!premiumMember?.customRoleId) {
			await interaction.reply({
				embeds: [
					createInfoEmbed(
						"You'll need to configure your premium custom role by running the `/custom-role edit` command first!",
					),
				],
				ephemeral: true,
			});

			return;
		}

		const guildRole = interaction.guild.roles.cache.get(premiumMember.customRoleId);

		// Custom role no longer exists
		if (!guildRole) {
			await this.container.prisma.premiumMember.update({
				where: { guildId_userId: { guildId: interaction.guildId, userId: interaction.user.id } },
				data: { customRoleId: null },
			});

			await interaction.reply({
				embeds: [
					createInfoEmbed('Your premium custom role no longer exists. Run `/custom-role edit` to recreate it.'),
				],
				ephemeral: true,
			});

			return;
		}

		try {
			if (interaction.member.roles.cache.has(guildRole.id)) {
				await interaction.member.roles.remove(guildRole, 'Toggled premium custom role');
				await interaction.reply({
					embeds: [createInfoEmbed('Your premium custom role has been removed from your profile.')],
					ephemeral: true,
				});
			} else {
				await interaction.member.roles.add(guildRole, 'Toggled premium custom role');
				await interaction.reply({
					embeds: [createInfoEmbed('Your premium custom role has been added to your profile.')],
					ephemeral: true,
				});
			}
		} catch (error) {
			this.container.logger.error(`Failed to toggle premium custom role`, {
				userId: interaction.user.id,
				guildId: interaction.guildId,
				error,
			});

			await interaction.reply({
				embeds: [
					createInfoEmbed(
						'I was unable to toggle your premium custom role. If this persists, please contact the admins.',
					),
				],
				ephemeral: true,
			});
		}
	}

	public override registerApplicationCommands(registry: Subcommand.Registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName(this.name)
				.setDescription('Manage your premium custom role.')
				.setDMPermission(false)
				.addSubcommand((subcommand) =>
					subcommand
						.setName('edit')
						.setDescription('Edits your premium custom role.')
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
					subcommand.setName('toggle').setDescription('Toggles the visibility of your premium custom role.'),
				),
		);
	}

	private parseColor(raw: string) {
		let numericParse: number | null = null;

		if (raw.startsWith('#')) {
			numericParse = Number.parseInt(raw.slice(1), 16);
		} else {
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

		this.container.logger.info(`[PREMIUM] Trying to resolve icon for premium custom role`, { url });

		let res: Response;

		try {
			res = await fetch(url);
		} catch (error) {
			this.container.logger.warn(`Failed to fetch icon for premium custom role`, {
				url,
				error,
			});
			// Invalid URLs or network errors, f
			return null;
		}

		if (!res.ok) {
			this.container.logger.warn(`Failed to fetch icon for premium custom role`, {
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

		this.container.logger.info(`[PREMIUM] Invalid icon format for premium custom role`, { url, exts });

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
