import { Subcommand, type SubcommandMappingArray } from '@sapphire/plugin-subcommands';
import {
	type ApplicationCommandOptionChoiceData,
	type AutocompleteInteraction,
	ButtonBuilder,
	ButtonStyle,
	ContainerBuilder,
	InteractionContextType,
	MessageFlags,
	PermissionFlagsBits,
	SeparatorBuilder,
	SeparatorSpacingSize,
	TextDisplayBuilder,
	time,
	TimestampStyles,
} from 'discord.js';
import {
	ClanDeletionStatus,
	ClanManager,
	ClanMemberAddStatus,
	ClanMemberRemoveStatus,
} from '../../../lib/abilities/ClanManager.js';

const Colors = {
	Success: 0x57f287,
	Error: 0xed4245,
	Info: 0x5865f2,
} as const;

export class ClanAdminCommand extends Subcommand {
	public subcommandMappings: SubcommandMappingArray = [
		{
			type: 'method',
			name: 'info',
			chatInputRun: 'infoSubcommand',
		},
		{
			type: 'method',
			name: 'list',
			chatInputRun: 'listSubcommand',
		},
		{
			type: 'method',
			name: 'remove-member',
			chatInputRun: 'removeMemberSubcommand',
		},
		{
			type: 'method',
			name: 'add-member',
			chatInputRun: 'addMemberSubcommand',
		},
		{
			type: 'method',
			name: 'delete',
			chatInputRun: 'deleteSubcommand',
		},
		{
			type: 'method',
			name: 'orphan',
			chatInputRun: 'orphanSubcommand',
		},
	];

	public async infoSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		const clanRole = interaction.options.getRole('clan');
		const user = interaction.options.getUser('user');

		if (!clanRole && !user) {
			await this.replyWithComponents(interaction, [
				this.errorMessage('You must provide either a clan role or a user.'),
			]);
			return;
		}

		let clanManager: ClanManager;
		let premiumMember: { customRoleId: string | null; userId: string } | null = null;

		if (user) {
			// Look up the clan by user (owner)
			premiumMember = await this.container.prisma.premiumMember.findFirst({
				where: { guildId: interaction.guildId, userId: user.id },
			});

			if (!premiumMember?.customRoleId) {
				await this.replyWithComponents(interaction, [this.errorMessage('This user does not own a clan.')]);
				return;
			}

			clanManager = new ClanManager(premiumMember.customRoleId, interaction.guildId);
		} else {
			clanManager = new ClanManager(clanRole!.id, interaction.guildId);
		}

		const clan = await clanManager.getClan();

		if (!clan) {
			await this.replyWithComponents(interaction, [
				this.errorMessage(
					user ? 'This user does not own a clan.' : 'This role does not have an associated clan.',
				),
			]);
			return;
		}

		const customRole = await clanManager.getCustomRole();
		const clanChannel = await clanManager.getClanChannel();
		const clanMembers = await clanManager.getClanMembers();

		// Find owner (the premium member who owns the custom role) if not already fetched
		if (!premiumMember) {
			premiumMember = await this.container.prisma.premiumMember.findFirst({
				where: { guildId: interaction.guildId, customRoleId: clan.customRoleId },
			});
		}

		const ownerMention = premiumMember ? `<@${premiumMember.userId}>` : 'Unknown (orphaned)';
		const channelMention = clanChannel ? `<#${clanChannel.id}>` : 'Not found';
		const roleMention = customRole ? `<@&${customRole.id}>` : 'Not found';
		const roleCreatedAt = customRole?.createdAt;

		const container = new ContainerBuilder()
			.setAccentColor(customRole?.color ?? Colors.Info)
			.addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${customRole?.name ?? 'Unknown Clan'}`))
			.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
			.addTextDisplayComponents(
				new TextDisplayBuilder().setContent(
					`**Owner:** ${ownerMention}\n` +
						`**Members:** ${clanMembers.size}\n` +
						`**Channel:** ${channelMention}\n` +
						`**Role:** ${roleMention}`,
				),
			)
			.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
			.addTextDisplayComponents(
				new TextDisplayBuilder().setContent(
					`**Visibility:** ${clan.isVisibleInDirectory ? 'Public' : 'Private'}\n` +
						`**Role Claimable:** ${clan.isRoleClaimable ? 'Yes' : 'No'}\n` +
						`**Status:** ${clan.deletionTaskId ? '⚠️ Scheduled for deletion' : '✅ Active'}` +
						(roleCreatedAt ?
							`\n**Role Created:** ${time(roleCreatedAt, TimestampStyles.RelativeTime)}`
						:	''),
				),
			);

		if (clan.description) {
			container
				.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
				.addTextDisplayComponents(new TextDisplayBuilder().setContent(`**Description:**\n${clan.description}`));
		}

		await this.replyWithComponents(interaction, [container], { parse: [] });
	}

	public async listSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		const user = interaction.options.getUser('user', true);

		// Find all clans this user is a member of
		const clanMemberships = await this.container.prisma.clanMember.findMany({
			where: { clanGuildId: interaction.guildId, userId: user.id },
			include: { clan: true },
		});

		// Check if user owns a clan
		const ownedClan = await this.container.prisma.premiumMember.findFirst({
			where: { guildId: interaction.guildId, userId: user.id, customRoleId: { not: null } },
		});

		if (clanMemberships.length === 0) {
			await this.replyWithComponents(interaction, [
				this.infoMessage(`**${user.username}** is not a member of any clans.`),
			]);
			return;
		}

		// Build the list
		const clanLines: string[] = [];

		for (const membership of clanMemberships) {
			const role = await interaction.guild.roles.fetch(membership.clanCustomRoleId).catch(() => null);
			const roleName = role?.name ?? 'Unknown';
			const isOwner = ownedClan?.customRoleId === membership.clanCustomRoleId;

			clanLines.push(`- **${roleName}**${isOwner ? ' 👑' : ''}`);
		}

		const container = new ContainerBuilder()
			.setAccentColor(Colors.Info)
			.addTextDisplayComponents(new TextDisplayBuilder().setContent(`## Clans for ${user.username}`))
			.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
			.addTextDisplayComponents(new TextDisplayBuilder().setContent(clanLines.join('\n')));

		if (ownedClan?.customRoleId) {
			container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
			container.addTextDisplayComponents(new TextDisplayBuilder().setContent('👑 = Clan owner'));
		}

		await this.replyWithComponents(interaction, [container]);
	}

	public async removeMemberSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		const clanRole = interaction.options.getRole('clan', true);
		const memberToRemove = interaction.options.getMember('member');

		if (!memberToRemove) {
			await this.replyWithComponents(interaction, [
				this.errorMessage('The specified member could not be found in this server.'),
			]);
			return;
		}

		const clanManager = new ClanManager(clanRole.id, interaction.guildId);
		const clan = await clanManager.getClan();

		if (!clan) {
			await this.replyWithComponents(interaction, [
				this.errorMessage('This role does not have an associated clan.'),
			]);
			return;
		}

		// Check if trying to remove the clan owner
		const premiumMember = await this.container.prisma.premiumMember.findFirst({
			where: { guildId: interaction.guildId, customRoleId: clanRole.id },
		});

		if (premiumMember?.userId === memberToRemove.id) {
			await this.replyWithComponents(interaction, [
				this.errorMessage(
					`You cannot remove the clan owner. Use </clan-admin delete:${interaction.commandId}> to delete the clan instead.`,
				),
			]);
			return;
		}

		let status: ClanMemberRemoveStatus;
		try {
			status = await clanManager.removeMember(memberToRemove);
		} catch (error) {
			this.container.logger.error('Error removing member from clan:', error);
			await this.replyWithComponents(interaction, [
				this.errorMessage('An error occurred while removing the member. They may not be in this clan.'),
			]);
			return;
		}

		if (status !== ClanMemberRemoveStatus.Removed) {
			await this.replyWithComponents(interaction, [
				this.errorMessage(ClanManager.getMemberRemoveStatusMessage(status)),
			]);
			return;
		}

		await this.replyWithComponents(interaction, [
			this.successMessage(`Removed **${memberToRemove.user.username}** from the clan **${clanRole.name}**.`),
		]);
	}

	public async addMemberSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		const clanRole = interaction.options.getRole('clan', true);
		const memberToAdd = interaction.options.getMember('member');

		if (!memberToAdd) {
			await this.replyWithComponents(interaction, [
				this.errorMessage('The specified member could not be found in this server.'),
			]);
			return;
		}

		const clanManager = new ClanManager(clanRole.id, interaction.guildId);
		const clan = await clanManager.getClan();

		if (!clan) {
			await this.replyWithComponents(interaction, [
				this.errorMessage('This role does not have an associated clan.'),
			]);
			return;
		}

		const status = await clanManager.inviteMember(memberToAdd.id, true);

		if (status !== ClanMemberAddStatus.Added) {
			await this.replyWithComponents(interaction, [
				this.errorMessage(ClanManager.getMemberAddStatusMessage(status)),
			]);
			return;
		}

		await this.replyWithComponents(interaction, [
			this.successMessage(`Added **${memberToAdd.user.username}** to the clan **${clanRole.name}**.`),
		]);
	}

	public async deleteSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		const clanRole = interaction.options.getRole('clan', true);
		const clanManager = new ClanManager(clanRole.id, interaction.guildId);
		const clan = await clanManager.getClan();

		if (!clan) {
			await this.replyWithComponents(interaction, [
				this.errorMessage('This role does not have an associated clan.'),
			]);
			return;
		}

		const confirmButton = new ButtonBuilder()
			.setCustomId('clan-admin-delete-confirm')
			.setLabel('Delete Clan')
			.setStyle(ButtonStyle.Danger);

		const cancelButton = new ButtonBuilder()
			.setCustomId('clan-admin-delete-cancel')
			.setLabel('Cancel')
			.setStyle(ButtonStyle.Secondary);

		const container = new ContainerBuilder()
			.setAccentColor(Colors.Error)
			.addTextDisplayComponents(new TextDisplayBuilder().setContent(`## Delete Clan: ${clanRole.name}`))
			.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
			.addTextDisplayComponents(
				new TextDisplayBuilder().setContent(
					'Are you sure you want to delete this clan?\n\n' +
						'This will:\n' +
						'- Delete the clan channel\n' +
						'- Remove all members from the clan\n\n' +
						'**This action cannot be undone.**',
				),
			)
			.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
			.addActionRowComponents((row) => row.addComponents(confirmButton, cancelButton));

		const response = await this.replyWithComponents(interaction, [container]);

		try {
			const buttonInteraction = await response.awaitMessageComponent({
				filter: (bi) => bi.user.id === interaction.user.id,
				time: 30_000,
			});

			if (buttonInteraction.customId === 'clan-admin-delete-cancel') {
				await buttonInteraction.update({
					components: [this.infoMessage('Clan deletion cancelled.')],
					flags: MessageFlags.IsComponentsV2,
				});
				return;
			}

			await buttonInteraction.update({
				components: [this.infoMessage('Deleting clan...')],
				flags: MessageFlags.IsComponentsV2,
			});

			const status = await clanManager.deleteClan();

			if (status !== ClanDeletionStatus.Deleted) {
				await this.replyWithComponents(interaction, [
					this.errorMessage(ClanManager.getDeletionStatusMessage(status)),
				]);
				return;
			}

			await this.replyWithComponents(interaction, [
				this.successMessage(`Deleted the clan **${clanRole.name}**.`),
			]);
		} catch {
			await this.replyWithComponents(interaction, [this.infoMessage('Clan deletion timed out.')]);
		}
	}

	public async orphanSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		const clanRole = interaction.options.getRole('clan', true);

		// We need to find the owner's user ID to properly initialize ClanManager for orphaning
		const premiumMember = await this.container.prisma.premiumMember.findFirst({
			where: { guildId: interaction.guildId, customRoleId: clanRole.id },
		});

		if (!premiumMember) {
			await this.replyWithComponents(interaction, [
				this.errorMessage(
					'Could not find the owner of this clan. The clan may already be orphaned or invalid.',
				),
			]);
			return;
		}

		const clanManager = new ClanManager(premiumMember.userId, interaction.guildId);
		const clan = await clanManager.getClan();

		if (!clan) {
			await this.replyWithComponents(interaction, [
				this.errorMessage('This role does not have an associated clan.'),
			]);
			return;
		}

		if (clan.deletionTaskId) {
			await this.replyWithComponents(interaction, [
				this.infoMessage('This clan is already marked as orphaned and scheduled for deletion.'),
			]);
			return;
		}

		await clanManager.makeClanOrphan(true);

		await this.replyWithComponents(interaction, [
			this.successMessage(
				`The clan **${clanRole.name}** has been marked as orphaned and will be automatically deleted in 1 week.`,
			),
		]);
	}

	public override async autocompleteRun(interaction: AutocompleteInteraction<'cached'>) {
		const focusedOption = interaction.options.getFocused(true);

		if (focusedOption.name !== 'clan') {
			return interaction.respond([]);
		}

		const search = focusedOption.value.toLowerCase();

		// Get all clans in this guild
		const clans = await this.container.prisma.clan.findMany({
			where: { guildId: interaction.guildId },
		});

		const choices: ApplicationCommandOptionChoiceData[] = [];

		for (const clan of clans) {
			const role = await interaction.guild.roles.fetch(clan.customRoleId).catch(() => null);

			if (!role) continue;

			if (search && !role.name.toLowerCase().includes(search)) continue;

			choices.push({
				name: role.name,
				value: clan.customRoleId,
			});

			if (choices.length >= 25) break;
		}

		return interaction.respond(choices);
	}

	public override registerApplicationCommands(registry: Subcommand.Registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName('clan-admin')
				.setDescription('Admin commands for managing clans.')
				.setDMPermission(false)
				.setContexts(InteractionContextType.Guild)
				.setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
				.addSubcommand((subcommand) =>
					subcommand
						.setName('info')
						.setDescription('Get detailed information about a clan')
						.addRoleOption((option) =>
							option.setName('clan').setDescription('The clan role to get info about'),
						)
						.addUserOption((option) => option.setName('user').setDescription('The user who owns the clan')),
				)
				.addSubcommand((subcommand) =>
					subcommand
						.setName('list')
						.setDescription('List clans a user is a member of')
						.addUserOption((option) =>
							option.setName('user').setDescription('The user to check').setRequired(true),
						),
				)
				.addSubcommand((subcommand) =>
					subcommand
						.setName('remove-member')
						.setDescription('Force remove a member from a clan')
						.addRoleOption((option) =>
							option.setName('clan').setDescription('The clan role').setRequired(true),
						)
						.addUserOption((option) =>
							option.setName('member').setDescription('The member to remove').setRequired(true),
						),
				)
				.addSubcommand((subcommand) =>
					subcommand
						.setName('add-member')
						.setDescription('Force add a member to a clan')
						.addRoleOption((option) =>
							option.setName('clan').setDescription('The clan role').setRequired(true),
						)
						.addUserOption((option) =>
							option.setName('member').setDescription('The member to add').setRequired(true),
						),
				)
				.addSubcommand((subcommand) =>
					subcommand
						.setName('delete')
						.setDescription('Force delete a clan')
						.addRoleOption((option) =>
							option.setName('clan').setDescription('The clan role to delete').setRequired(true),
						),
				)
				.addSubcommand((subcommand) =>
					subcommand
						.setName('orphan')
						.setDescription('Mark a clan as orphaned (schedules deletion in 1 week)')
						.addRoleOption((option) =>
							option
								.setName('clan')
								.setDescription('The clan role to mark as orphaned')
								.setRequired(true),
						),
				),
		);
	}

	private async replyWithComponents(
		interaction: Subcommand.ChatInputCommandInteraction<'cached'>,
		components: ContainerBuilder[],
		allowedMentions?: { parse: [] },
	) {
		return interaction.editReply({
			components,
			flags: MessageFlags.IsComponentsV2,
			allowedMentions,
		});
	}

	private successMessage(message: string): ContainerBuilder {
		return new ContainerBuilder()
			.setAccentColor(Colors.Success)
			.addTextDisplayComponents(new TextDisplayBuilder().setContent(`✅ ${message}`));
	}

	private errorMessage(message: string): ContainerBuilder {
		return new ContainerBuilder()
			.setAccentColor(Colors.Error)
			.addTextDisplayComponents(new TextDisplayBuilder().setContent(`❌ ${message}`));
	}

	private infoMessage(message: string): ContainerBuilder {
		return new ContainerBuilder()
			.setAccentColor(Colors.Info)
			.addTextDisplayComponents(new TextDisplayBuilder().setContent(message));
	}
}
