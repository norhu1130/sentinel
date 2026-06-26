import { Buffer } from 'node:buffer';
import { Subcommand, type SubcommandMappingArray } from '@sapphire/plugin-subcommands';
import {
	MessageFlags,
	type MessageComponentInteraction,
	type RoleColorsResolvable,
	type RoleEditOptions,
} from 'discord.js';
import looksSame, { type Color } from 'looks-same';
import magicBytes from 'magic-bytes.js';
import { ClanDeletionStatus, ClanManager } from '../../../lib/abilities/ClanManager.js';
import { MemberAbilities } from '../../../lib/abilities/MemberAbilities.js';
import { RoleAbilitiesCalculator } from '../../../lib/abilities/RoleAbilities.js';
import { recordClanEvent } from '../../../lib/utils/clanHistory.js';
import { createErrorEmbed, createInfoEmbed } from '../../../lib/utils/createEmbed.js';
import { LogPrefix } from '../../../lib/utils/logPrefix.js';
import { waitForButtonConfirm } from '../../../lib/utils/waitForInteraction.js';
import { ensureFullMember } from '../../../lib/utils.js';

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
	{
		color: 0x313338,
		matched: false,
		roleName: 'Discord dark mode background',
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
		{
			type: 'method',
			name: 'delete',
			chatInputRun: 'deleteSubcommand',
		},
	];

	public async editSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		await ensureFullMember(interaction.member);

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
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		if (!memberAbilities.hasAbility('canCreateCustomRole')) {
			await interaction.reply({
				embeds: [createInfoEmbed('You do not have the ability to create a custom role.')],
				flags: MessageFlags.Ephemeral,
			});

			return;
		}

		await interaction.deferReply({
			flags: MessageFlags.Ephemeral,
		});

		const premiumMember = await this.container.prisma.premiumMember.findFirst({
			where: { guildId: interaction.guildId, userId: interaction.user.id },
		});
		const premiumMemberFromOtherGuilds = await this.container.prisma.premiumMember.findMany({
			where: { guildId: { not: interaction.guildId }, userId: interaction.user.id },
		});
		const customRolesFromOtherGuilds = premiumMemberFromOtherGuilds
			?.map((premiumMember) => premiumMember?.customRoleId)
			?.filter(Boolean);

		const premiumRoles = [...interaction.guild.roles.cache.values()].filter((role) =>
			premiumRoleIds.includes(role.id),
		);
		const lowestPremiumRole = premiumRoles.reduce(
			(role, lowestRole) => (role.position < lowestRole.position ? role : lowestRole),
			premiumRoles[0],
		);

		const positionRole = interaction.guild.roles.cache.get(guildConfig?.startingPositionRoleId ?? '') ?? null;
		const oldRole = interaction.guild.roles.cache.get(premiumMember?.customRoleId ?? '') ?? null;
		const position = (positionRole?.position ?? lowestPremiumRole?.position ?? 0) + 1;

		if (
			!oldRole &&
			customRolesFromOtherGuilds.length > 0 &&
			!memberAbilities.hasAbility('areAbilitiesMultiGuild')
		) {
			await interaction.editReply({
				embeds: [
					createInfoEmbed(
						'You cannot create a custom role in this server as you already have a custom role in another server.',
					),
				],
			});

			return;
		}

		const name = interaction.options.getString('name');
		const rawColor = interaction.options.getString('color');
		const rawColor2 = interaction.options.getString('color2');
		const iconUrl = interaction.options.getString('icon-url');
		const iconUpload = interaction.options.getAttachment('icon-upload');

		if (!oldRole && !name) {
			await interaction.editReply({
				embeds: [
					createInfoEmbed('You do not have a premium custom role. Please provide a name to create one!'),
				],
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
		const color2 = color && rawColor2 ? this.parseColor(rawColor2) : undefined;

		if (color === null || color2 === null) {
			await interaction.editReply({
				embeds: [createInfoEmbed('Invalid color provided. Please provide a valid hexadecimal color.')],
			});

			return;
		}

		if (color || color2) {
			const staffColors: ColorMatch[] = (
				(guildConfig?.staffRoles
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
					.filter((role) => role !== null) as ColorMatch[]) ?? []
			).concat(forbiddenColors());

			for (const code of [color, color2]) {
				if (!code) {
					continue;
				}

				this.similarityInColors(code, staffColors);

				if (staffColors.some((data) => data.matched)) {
					this.container.logger.info(
						`Color similarity data:`,
						JSON.stringify({
							userId: interaction.user.id,
							guildId: interaction.guildId,
							staffColors,
							inputColor: code,
						}),
					);

					await interaction.editReply({
						embeds: [
							createInfoEmbed(
								`Your premium custom role color #${code.toString(16)} is too similar to the staff roles. Please choose a different color.`,
							),
						],
					});

					return;
				}
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
			colors:
				color ?
					{ primaryColor: color, secondaryColor: color2 }
				:	(oldRole?.colors as RoleColorsResolvable | undefined),
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

			// Record cosmetic changes to an existing custom role (the clan's identity), keyed by role id.
			if (oldRole) {
				if (name && name !== oldRole.name) {
					await recordClanEvent({
						guildId: interaction.guildId,
						customRoleId: newRole.id,
						clanName: newRole.name,
						ownerUserId: interaction.user.id,
						actorUserId: interaction.user.id,
						eventType: 'Renamed',
						metadata: { from: oldRole.name, to: newRole.name },
					});
				}

				if (iconUrl || iconUpload) {
					await recordClanEvent({
						guildId: interaction.guildId,
						customRoleId: newRole.id,
						clanName: newRole.name,
						ownerUserId: interaction.user.id,
						actorUserId: interaction.user.id,
						eventType: 'IconChanged',
					});
				}
			}

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
		await ensureFullMember(interaction.member);

		const roleAbilitiesCalculator = new RoleAbilitiesCalculator(interaction.guild.id);
		const memberAbilities = new MemberAbilities(interaction.member);

		await roleAbilitiesCalculator.computeList();
		await memberAbilities.computeAbilities();

		if (roleAbilitiesCalculator.getPremiumRoleIds('canCreateCustomRole').length < 1) {
			await interaction.reply({
				embeds: [createInfoEmbed("This server doesn't support premium custom roles.")],
				flags: MessageFlags.Ephemeral,
			});

			return;
		}

		if (!memberAbilities.hasAbility('canCreateCustomRole')) {
			await interaction.reply({
				embeds: [createInfoEmbed('You do not have the ability to create a custom role.')],
				flags: MessageFlags.Ephemeral,
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
				flags: MessageFlags.Ephemeral,
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
					createInfoEmbed(
						'Your premium custom role no longer exists. Run `/custom-role edit` to recreate it.',
					),
				],
				flags: MessageFlags.Ephemeral,
			});

			return;
		}

		try {
			if (interaction.member.roles.cache.has(guildRole.id)) {
				await interaction.member.roles.remove(guildRole, 'Toggled premium custom role');
				await interaction.reply({
					embeds: [createInfoEmbed('Your premium custom role has been removed from your profile.')],
					flags: MessageFlags.Ephemeral,
				});
			} else {
				await interaction.member.roles.add(guildRole, 'Toggled premium custom role');
				await interaction.reply({
					embeds: [createInfoEmbed('Your premium custom role has been added to your profile.')],
					flags: MessageFlags.Ephemeral,
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
				flags: MessageFlags.Ephemeral,
			});
		}
	}

	public async deleteSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		await interaction.deferReply({
			flags: MessageFlags.Ephemeral,
		});

		const clanManager = new ClanManager(interaction.member);
		const premiumMember = await this.container.prisma.premiumMember.findFirst({
			where: { guildId: interaction.guildId, userId: interaction.user.id },
		});
		const oldRole = interaction.guild.roles.cache.get(premiumMember?.customRoleId ?? '') ?? null;

		if (!oldRole) {
			await interaction.editReply({
				embeds: [createInfoEmbed('You do not have a premium custom role.')],
			});

			return;
		}

		const oldClan = await clanManager.getClan();
		const hasClan = Boolean(oldClan);
		const confirmMessageWithoutClan = `# ⚠️ WARNING\n**You are about to delete your custom role**\nYour custom role will be entirely deleted and you will have to re-create it if you want it back.\n\nAre you sure you want to delete your custom role?`;
		const confirmMessageWithClan = `# ⚠️ WARNING\n**You are about to delete both your custom role AND your clan**\n-# A clan cannot exist without its corresponding custom role\n\n- Your clan's text channel will be entirely deleted with no possibility to recover it.\n- Your custom role will be entirely deleted and you will have to re-create it if you want it back.\n\nAre you sure you want to delete both your clan and your custom role?`;

		const { context, confirmed } = await waitForButtonConfirm(
			interaction,
			oldClan ? confirmMessageWithClan : confirmMessageWithoutClan,
			{
				confirmText: 'Yes',
				cancelText: 'No',
				restrictToId: interaction.user.id,
				collectorTime: 30_000,
			},
		);

		const newInteraction = context as MessageComponentInteraction;

		if (!confirmed) {
			await newInteraction.editReply({
				content: '',
				embeds: [createInfoEmbed('Cancelled custom role deletion.')],
				components: [],
			});

			return;
		}

		if (oldClan) {
			const clanDeletionStatus = await clanManager.deleteClan({
				actorUserId: interaction.user.id,
				reason: 'Owner deleted their custom role',
			});

			if (clanDeletionStatus !== ClanDeletionStatus.Deleted) {
				const errorMessage = `Your custom role could not be deleted because your clan could not be deleted: ${ClanManager.getDeletionStatusMessage(clanDeletionStatus)}`;

				this.container.logger.error(
					`${LogPrefix.CUSTOM_ROLE} ${interaction.member.user.username} failed to delete: ${errorMessage}`,
				);
				await newInteraction.editReply({
					content: '',
					embeds: [createErrorEmbed(errorMessage)],
					components: [],
				});

				return;
			}
		}

		try {
			await interaction.guild.roles.delete(oldRole);
		} catch (error) {
			this.container.logger.error(
				`${LogPrefix.CUSTOM_ROLE} ${interaction.member.user.username} failed to delete: could not delete Discord role.`,
				{
					userId: interaction.user.id,
					guildId: interaction.guildId,
					error,
				},
			);

			await newInteraction.editReply({
				content: '',
				embeds: [
					createInfoEmbed(
						'Your custom role could not be deleted from the server. If this persists, please contact modmail.',
					),
				],
				components: [],
			});

			return;
		}

		try {
			await this.container.prisma.premiumMember.delete({
				where: {
					guildId_userId: { guildId: interaction.guildId, userId: interaction.user.id },
				},
			});

			await newInteraction.editReply({
				content: '',
				embeds: [
					createInfoEmbed(
						hasClan ?
							`Your premium custom role and clan have been deleted.`
						:	`Your premium custom role has been deleted.`,
					),
				],
				components: [],
			});
		} catch (error) {
			this.container.logger.error(
				`${LogPrefix.CUSTOM_ROLE} ${interaction.member.user.username} failed to delete from the database.`,
				{
					userId: interaction.user.id,
					guildId: interaction.guildId,
					error,
				},
			);

			await newInteraction.editReply({
				content: '',
				embeds: [
					createInfoEmbed(
						'Your custom role could not be deleted from the database. If this persists, please contact modmail.',
					),
				],
				components: [],
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
						.setDescription('Edit your premium custom role.')
						.addStringOption((name) =>
							name
								.setName('name')
								.setDescription('The name of the custom role')
								.setMinLength(1)
								.setMaxLength(100),
						)
						.addStringOption((color) =>
							color.setName('color').setDescription('The color of the custom role (#FFFFFF format)'),
						)
						.addStringOption((color) =>
							color
								.setName('color2')
								.setDescription(
									'The second color of the custom role, if you want a gradient (#FFFFFF format)',
								)
								.setRequired(false),
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
					subcommand.setName('toggle').setDescription('Toggle the visibility of your premium custom role.'),
				)
				.addSubcommand((subcommand) =>
					subcommand.setName('delete').setDescription('Delete your premium custom role.'),
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

		this.container.logger.info(`${LogPrefix.PREMIUM} Trying to resolve icon for premium custom role`, { url });

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

		this.container.logger.info(`${LogPrefix.PREMIUM} Invalid icon format for premium custom role`, { url, exts });

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
