import type { Clan } from '@prisma/client';
import { Subcommand, type SubcommandMappingArray } from '@sapphire/plugin-subcommands';
import {
	type ApplicationCommandOptionChoiceData,
	type AutocompleteInteraction,
	ButtonBuilder,
	ButtonStyle,
	ComponentType,
	ContainerBuilder,
	InteractionContextType,
	type Message,
	MessageFlags,
	PermissionFlagsBits,
	type Role,
	SeparatorBuilder,
	SeparatorSpacingSize,
	TextDisplayBuilder,
	time,
	TimestampStyles,
	UserSelectMenuBuilder,
} from 'discord.js';
import {
	ClanDeletionStatus,
	ClanManager,
	ClanMemberAddStatus,
	ClanMemberRemoveStatus,
	ClanPermissionEditStatus,
	ClanPermissionEditTarget,
} from '../../../lib/abilities/ClanManager.js';
import { LogPrefix } from '../../../lib/utils/logPrefix.js';

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
		{
			type: 'method',
			name: 'sync-permission',
			chatInputRun: 'syncPermissionSubcommand',
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

		const hasPremiumEntry = Boolean(premiumMember);
		// A clan with no premium owner entry is unrecoverable on its own (the owner<->clan link is gone),
		// so offer a manual restore as long as the Discord role still exists to reattach it to.
		const isRestorable = !hasPremiumEntry && Boolean(customRole);

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
						`**Status:** ${clan.deletionTaskId ? '⚠️ Scheduled for deletion' : '✅ Active'}\n` +
						`**Clan DB entry:** ✅ Present\n` +
						`**Premium entry:** ${hasPremiumEntry ? '✅ Present' : '❌ Missing'}` +
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

		if (isRestorable) {
			container
				.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
				.addTextDisplayComponents(
					new TextDisplayBuilder().setContent(
						'⚠️ This clan has **no premium owner entry**, so it cannot be restored automatically if the owner returns. Rebuild the link below.',
					),
				)
				.addActionRowComponents((row) =>
					row.addComponents(
						new ButtonBuilder()
							.setCustomId('clan-admin-restore')
							.setLabel('Restore Clan')
							.setStyle(ButtonStyle.Success),
					),
				);
		}

		const response = await this.replyWithComponents(interaction, [container], { parse: [] });

		if (isRestorable && customRole) {
			await this.runClanRestoreFlow(interaction, response, clan, customRole);
		}
	}

	/**
	 * Walks an admin through rebuilding the premium owner entry for an orphaned clan whose owner
	 * link was lost (e.g. the premium member row was deleted). DB-only: assumes the clan role and
	 * channel still exist; it recreates the PremiumMember row and un-orphans the clan.
	 */
	private async runClanRestoreFlow(
		interaction: Subcommand.ChatInputCommandInteraction<'cached'>,
		response: Message<true>,
		clan: Clan,
		customRole: Role,
	): Promise<void> {
		const { customRoleId } = clan;
		const clanName = customRole.name;

		let restoreClick;
		try {
			restoreClick = await response.awaitMessageComponent({
				componentType: ComponentType.Button,
				filter: (component) =>
					component.user.id === interaction.user.id && component.customId === 'clan-admin-restore',
				time: 60_000,
			});
		} catch {
			// Admin never clicked Restore - leave the info message untouched.
			return;
		}

		this.container.logger.info(
			`${LogPrefix.PREMIUM} [RESTORE] Admin ${interaction.user.id} started restore for clan role ${customRoleId} in guild ${interaction.guildId}`,
		);

		const ownerSelect = new UserSelectMenuBuilder()
			.setCustomId('clan-admin-restore-owner')
			.setPlaceholder('Select the clan owner')
			.setMinValues(1)
			.setMaxValues(1);

		await restoreClick.update({
			components: [
				new ContainerBuilder()
					.setAccentColor(Colors.Info)
					.addTextDisplayComponents(
						new TextDisplayBuilder().setContent(
							`## Restore Clan: ${clanName}\n\nSelect the member who should own this clan. This rebuilds the premium owner entry${
								clan.deletionTaskId ? ' and cancels the scheduled deletion' : ''
							}.`,
						),
					)
					.addActionRowComponents((row) => row.addComponents(ownerSelect)),
			],
			flags: MessageFlags.IsComponentsV2,
		});

		let ownerSelectInteraction;
		try {
			ownerSelectInteraction = await response.awaitMessageComponent({
				componentType: ComponentType.UserSelect,
				filter: (component) =>
					component.user.id === interaction.user.id && component.customId === 'clan-admin-restore-owner',
				time: 60_000,
			});
		} catch {
			this.container.logger.info(
				`${LogPrefix.PREMIUM} [RESTORE] Restore for clan role ${customRoleId} timed out waiting for owner selection`,
			);
			await interaction.editReply({
				components: [this.infoMessage('Clan restore timed out.')],
				flags: MessageFlags.IsComponentsV2,
			});
			return;
		}

		const ownerId = ownerSelectInteraction.values[0];

		await ownerSelectInteraction.update({
			components: [this.infoMessage(`Restoring clan **${clanName}** for <@${ownerId}>...`)],
			flags: MessageFlags.IsComponentsV2,
		});

		// Don't clobber a user who already owns a different custom role/clan.
		const existingForUser = await this.container.prisma.premiumMember.findFirst({
			where: { guildId: interaction.guildId, userId: ownerId },
		});

		if (existingForUser?.customRoleId && existingForUser.customRoleId !== customRoleId) {
			this.container.logger.warn(
				`${LogPrefix.PREMIUM} [RESTORE] Aborted: ${ownerId} already owns role ${existingForUser.customRoleId} in guild ${interaction.guildId}`,
			);
			await interaction.editReply({
				components: [
					this.errorMessage(
						`<@${ownerId}> already owns another custom role (<@&${existingForUser.customRoleId}>). Restore aborted so it isn't overwritten.`,
					),
				],
				flags: MessageFlags.IsComponentsV2,
				allowedMentions: { parse: [] },
			});
			return;
		}

		// Don't hand a clan to someone new if it's somehow already owned.
		const existingForClan = await this.container.prisma.premiumMember.findFirst({
			where: { guildId: interaction.guildId, customRoleId },
		});

		if (existingForClan && existingForClan.userId !== ownerId) {
			this.container.logger.warn(
				`${LogPrefix.PREMIUM} [RESTORE] Aborted: clan role ${customRoleId} already owned by ${existingForClan.userId} in guild ${interaction.guildId}`,
			);
			await interaction.editReply({
				components: [this.errorMessage(`This clan is already owned by <@${existingForClan.userId}>.`)],
				flags: MessageFlags.IsComponentsV2,
				allowedMentions: { parse: [] },
			});
			return;
		}

		try {
			await this.container.prisma.premiumMember.upsert({
				where: { guildId_userId: { guildId: interaction.guildId, userId: ownerId } },
				create: { guildId: interaction.guildId, userId: ownerId, customRoleId },
				update: { customRoleId },
			});

			this.container.logger.info(
				`${LogPrefix.PREMIUM} [RESTORE] Recreated premium owner entry ${ownerId} -> role ${customRoleId} in guild ${interaction.guildId}`,
			);

			// makeClanNotOrphan resolves the owner from the (now restored) premium entry, cancels the
			// scheduled deletion, re-adds the owner to the clan and restores their channel permissions.
			const clanManager = new ClanManager(ownerId, interaction.guildId);
			await clanManager.makeClanNotOrphan();

			this.container.logger.info(
				`${LogPrefix.PREMIUM} [RESTORE] Clan ${customRoleId} restored to owner ${ownerId} in guild ${interaction.guildId}`,
			);
		} catch (error) {
			this.container.logger.error(
				`${LogPrefix.PREMIUM} [RESTORE] Failed to restore clan ${customRoleId} for ${ownerId} in guild ${interaction.guildId}:`,
				error,
			);
			await interaction.editReply({
				components: [
					this.errorMessage('Something went wrong while restoring the clan. Check the logs for details.'),
				],
				flags: MessageFlags.IsComponentsV2,
			});
			return;
		}

		await interaction.editReply({
			components: [
				this.successMessage(
					`Restored the clan **${clanName}** and set <@${ownerId}> as the owner${
						clan.deletionTaskId ? '. The scheduled deletion has been cancelled.' : '.'
					}`,
				),
			],
			flags: MessageFlags.IsComponentsV2,
			allowedMentions: { parse: [] },
		});
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

	public async syncPermissionSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		const permission = interaction.options.getString('permission', true);
		const actionString = interaction.options.getString('action', true);
		const targetString = interaction.options.getString('target', true);

		if (!(permission in PermissionFlagsBits)) {
			await this.replyWithComponents(interaction, [this.errorMessage(`Unknown permission: \`${permission}\`.`)]);
			return;
		}

		const action: boolean | null =
			actionString === 'allow' ? true
			: actionString === 'deny' ? false
			: null;
		const target = targetString === 'everyone' ? ClanPermissionEditTarget.Everyone : ClanPermissionEditTarget.Owner;

		const owners = await this.container.prisma.premiumMember.findMany({
			where: { guildId: interaction.guildId, customRoleId: { not: null } },
		});

		if (owners.length === 0) {
			await this.replyWithComponents(interaction, [this.infoMessage('No clans found in this server.')]);
			return;
		}

		const managers: ClanManager[] = [];
		let missingChannelCount = 0;

		for (const owner of owners) {
			const manager = new ClanManager(owner.userId, interaction.guildId);
			const channel = await manager.getClanChannel();
			if (channel) {
				managers.push(manager);
			} else {
				missingChannelCount++;
			}
		}

		if (managers.length === 0) {
			await this.replyWithComponents(interaction, [this.errorMessage('No clan channels were found to update.')]);
			return;
		}

		const actionLabel =
			action === true ? '✅ Allow'
			: action === false ? '❌ Deny'
			: '🔄 Reset';
		const targetLabel = target === ClanPermissionEditTarget.Owner ? 'clan owner' : '@everyone';

		const summaryLines = [
			`**Permission:** \`${permission}\``,
			`**Action:** ${actionLabel}`,
			`**Target:** ${targetLabel}`,
			`**Channels to update:** ${managers.length}`,
		];
		if (missingChannelCount > 0) {
			summaryLines.push(`**Skipped (no channel):** ${missingChannelCount}`);
		}

		const confirmButton = new ButtonBuilder()
			.setCustomId('clan-admin-sync-confirm')
			.setLabel('Apply')
			.setStyle(ButtonStyle.Primary);

		const cancelButton = new ButtonBuilder()
			.setCustomId('clan-admin-sync-cancel')
			.setLabel('Cancel')
			.setStyle(ButtonStyle.Secondary);

		const container = new ContainerBuilder()
			.setAccentColor(Colors.Info)
			.addTextDisplayComponents(new TextDisplayBuilder().setContent('## Sync Clan Permission'))
			.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
			.addTextDisplayComponents(new TextDisplayBuilder().setContent(summaryLines.join('\n')))
			.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
			.addActionRowComponents((row) => row.addComponents(confirmButton, cancelButton));

		const response = await this.replyWithComponents(interaction, [container]);

		try {
			const buttonInteraction = await response.awaitMessageComponent({
				filter: (bi) => bi.user.id === interaction.user.id,
				time: 30_000,
			});

			if (buttonInteraction.customId === 'clan-admin-sync-cancel') {
				await buttonInteraction.update({
					components: [this.infoMessage('Sync cancelled.')],
					flags: MessageFlags.IsComponentsV2,
				});
				return;
			}

			await buttonInteraction.update({
				components: [this.infoMessage(`Updating ${managers.length} clan channels...`)],
				flags: MessageFlags.IsComponentsV2,
			});

			let succeeded = 0;
			let failed = 0;
			let noOwner = 0;
			let ownerLeftGuild = 0;
			let firstError: string | undefined;

			for (const manager of managers) {
				const result = await manager.editChannelPermission(target, permission, action);
				if (result.status === ClanPermissionEditStatus.Success) {
					succeeded++;
				} else if (result.status === ClanPermissionEditStatus.NoOwner) {
					noOwner++;
				} else if (result.status === ClanPermissionEditStatus.OwnerNotInGuild) {
					ownerLeftGuild++;
				} else {
					failed++;
					if (!firstError && result.error) firstError = result.error;
				}
			}

			const resultLines = [
				`**Permission:** \`${permission}\``,
				`**Action:** ${actionLabel}`,
				`**Target:** ${targetLabel}`,
				`**Updated:** ${succeeded}`,
			];
			if (failed > 0) resultLines.push(`**Failed:** ${failed}`);
			if (noOwner > 0) resultLines.push(`**Skipped (no owner):** ${noOwner}`);
			if (ownerLeftGuild > 0) resultLines.push(`**Skipped (owner left guild):** ${ownerLeftGuild}`);
			if (missingChannelCount > 0) resultLines.push(`**Skipped (no channel):** ${missingChannelCount}`);
			if (firstError) {
				const safeError = firstError.slice(0, 500).replaceAll('`', "'");
				resultLines.push('', '**First error:**', `\`\`\`\n${safeError}\n\`\`\``);
			}

			const hasIssues = failed > 0 || noOwner > 0 || ownerLeftGuild > 0 || missingChannelCount > 0;

			await this.replyWithComponents(interaction, [
				new ContainerBuilder()
					.setAccentColor(
						failed > 0 ? Colors.Error
						: hasIssues ? Colors.Info
						: Colors.Success,
					)
					.addTextDisplayComponents(new TextDisplayBuilder().setContent('## Sync Complete'))
					.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
					.addTextDisplayComponents(new TextDisplayBuilder().setContent(resultLines.join('\n'))),
			]);
		} catch {
			await this.replyWithComponents(interaction, [this.infoMessage('Sync confirmation timed out.')]);
		}
	}

	public override async autocompleteRun(interaction: AutocompleteInteraction<'cached'>) {
		const focusedOption = interaction.options.getFocused(true);

		if (focusedOption.name === 'permission') {
			const search = focusedOption.value.toLowerCase();
			const permissionNames = Object.keys(PermissionFlagsBits);

			const filtered = permissionNames
				.filter((name) => !search || name.toLowerCase().includes(search))
				.sort((a, b) => {
					const aStarts = a.toLowerCase().startsWith(search);
					const bStarts = b.toLowerCase().startsWith(search);
					if (aStarts && !bStarts) return -1;
					if (!aStarts && bStarts) return 1;
					return a.localeCompare(b);
				})
				.slice(0, 25);

			return interaction.respond(filtered.map((name) => ({ name, value: name })));
		}

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
				)
				.addSubcommand((subcommand) =>
					subcommand
						.setName('sync-permission')
						.setDescription('Bulk allow/deny/reset a permission across all clan channels')
						.addStringOption((option) =>
							option
								.setName('permission')
								.setDescription('The permission to modify')
								.setRequired(true)
								.setAutocomplete(true),
						)
						.addStringOption((option) =>
							option
								.setName('action')
								.setDescription('Allow, deny, or reset (remove the override)')
								.setRequired(true)
								.addChoices(
									{ name: 'Allow', value: 'allow' },
									{ name: 'Deny', value: 'deny' },
									{ name: 'Reset', value: 'reset' },
								),
						)
						.addStringOption((option) =>
							option
								.setName('target')
								.setDescription('Whose override to modify')
								.setRequired(true)
								.addChoices(
									{ name: 'Clan owner', value: 'owner' },
									{ name: '@everyone', value: 'everyone' },
								),
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
