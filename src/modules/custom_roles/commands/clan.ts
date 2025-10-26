import { Subcommand, type SubcommandMappingArray } from '@sapphire/plugin-subcommands';
import { ChannelType } from 'discord-api-types/v10';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Collection, type MessageComponentInteraction } from 'discord.js';
import { PaginatedMessage } from '@sapphire/discord.js-utilities';
import { chunk } from '@sapphire/utilities';

import {
	ClanCreationStatus,
	ClanDeletionStatus,
	ClanManager,
	ClanMemberRemoveStatus,
	MAX_MEMBERS_IN_CLAN,
} from '../../../lib/abilities/ClanManager.js';
import { MemberAbilities } from '../../../lib/abilities/MemberAbilities.js';
import { createErrorEmbed, createInfoEmbed } from '../../../lib/utils/createEmbed.js';
import { waitForButtonConfirm } from '../../../lib/utils/waitForInteraction.js';

const clanInviteCooldown = 60 * 60_000; // 60 seconds * 60 minutes * 24 hours = 1 hour
const clanInviteDelayString = 'an hour';
const cooldowns = new Collection<string, number>();

export class ClanCommand extends Subcommand {
	public subcommandMappings: SubcommandMappingArray = [
		{
			type: 'method',
			name: 'create',
			chatInputRun: 'createSubcommand',
		},
		{
			type: 'method',
			name: 'invite',
			chatInputRun: 'inviteSubcommand',
		},
		{
			type: 'method',
			name: 'kick',
			chatInputRun: 'kickSubcommand',
		},
		{
			type: 'method',
			name: 'toggle-claim',
			chatInputRun: 'toggleClaimSubcommand',
		},
		{
			type: 'method',
			name: 'delete',
			chatInputRun: 'deleteSubcommand',
		},
		{
			type: 'method',
			name: 'leave',
			chatInputRun: 'leaveSubcommand',
		},
		{
			type: 'method',
			name: 'claim-role',
			chatInputRun: 'claimRoleSubcommand',
		},
		{
			type: 'method',
			name: 'unclaim-role',
			chatInputRun: 'unclaimRoleSubcommand',
		},
		{
			type: 'method',
			name: 'set-description',
			chatInputRun: 'setDescriptionSubcommand',
		},
		{
			type: 'method',
			name: 'toggle-directory',
			chatInputRun: 'toggleDirectorySubcommand',
		},
		{
			type: 'method',
			name: 'toggle-directory',
			chatInputRun: 'toggleDirectorySubcommand',
		},
		{
			type: 'method',
			name: 'members',
			chatInputRun: 'membersSubcommand',
		},
	];

	public async createSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		await interaction.deferReply({ ephemeral: true });

		const description = interaction.options.getString('description');

		const memberAbilities = new MemberAbilities(interaction.member);
		const clanManager = new ClanManager(interaction.member);
		const oldClan = await clanManager.getClan();
		const otherClans = await clanManager.getClansFromOtherGuilds();

		await memberAbilities.computeAbilities();

		if (!oldClan && otherClans.length > 0 && !memberAbilities.hasAbility('areAbilitiesMultiGuild')) {
			await interaction.editReply({
				embeds: [
					createInfoEmbed(
						'You cannot create a clan in this server as you already have a clan in another server.',
					),
				],
			});

			return;
		}

		const clanCreationStatus = await clanManager.createClan(description);

		if (clanCreationStatus !== ClanCreationStatus.Created) {
			await interaction.editReply({
				embeds: [createErrorEmbed(ClanManager.getCreationStatusMessage(clanCreationStatus))],
			});

			return;
		}

		const inviteCommand = `</clan invite:${interaction.command!.id}>`;
		const clanChannel = await clanManager.getClanChannel();

		await interaction.editReply({
			embeds: [
				createInfoEmbed(
					`# 🎉 Your clan has been created\nSend the first message: <#${clanChannel!.id}>!\n\nYou can invite people using the ${inviteCommand} command.`,
				),
			],
		});
	}

	public async deleteSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		await interaction.deferReply({ ephemeral: true });

		const clanManager = new ClanManager(interaction.member);

		const { context, confirmed } = await waitForButtonConfirm(
			interaction,
			`# ⚠️ WARNING\n**You are about to delete your clan**\nThe text channel will be entirely deleted with no possibility to recover it.\n\nAre you sure you want to delete your clan?`,
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
				embeds: [createInfoEmbed('Cancelled clan deletion.')],
				components: [],
			});

			return;
		}

		const clanDeletionStatus = await clanManager.deleteClan();

		if (clanDeletionStatus !== ClanDeletionStatus.Deleted) {
			const errorMessage = ClanManager.getDeletionStatusMessage(clanDeletionStatus);

			this.container.logger.error(
				`[CLAN ${interaction.member.id}] ${interaction.member.user.username} failed to delete clan: ${errorMessage}`,
			);
			await newInteraction.editReply({
				content: '',
				embeds: [createErrorEmbed(errorMessage)],
				components: [],
			});

			return;
		}

		const createCommand = `</clan create:${interaction.command!.id}>`;

		await newInteraction.editReply({
			content: '',
			embeds: [
				createInfoEmbed(
					`# 🗑️ Your clan has been deleted\nYou can recreate a clan using the ${createCommand} command.`,
				),
			],
			components: [],
		});
	}

	public async inviteSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		await interaction.deferReply({ ephemeral: true });

		const memberToInvite = interaction.options.getMember('member');

		if (!memberToInvite) {
			this.container.logger.info(
				`[CLAN ${interaction.member.id}] ${interaction.member.user.username} tried to invite a member but the provided member was not found.`,
			);
			await interaction.editReply({
				embeds: [createErrorEmbed('The provided member could not be found.')],
				components: [],
			});

			return;
		}

		const cooldownKey = `${interaction.user.id}-${memberToInvite.id}`;

		if (cooldowns.has(cooldownKey) && Date.now() < cooldowns.get(cooldownKey)!) {
			this.container.logger.info(
				`[CLAN ${interaction.member.id}] ${interaction.member.user.username} tried to invite a member but they were on cooldown.`,
			);
			await interaction.editReply({
				embeds: [createErrorEmbed(`You can only invite the same member once ${clanInviteDelayString}.`)],
				components: [],
			});

			return;
		}

		const clanManager = new ClanManager(interaction.member);
		const invitesChannel = await clanManager.getClanInvitesChannel();
		const clan = await clanManager.getClan();
		const clanName = (await clanManager.getCustomRole())!.name;
		const clanMembers = await clanManager.getDiscordClanMembers();

		if (!invitesChannel) {
			this.container.logger.info(
				`[CLAN ${interaction.member.id}] ${interaction.member.user.username} tried to invite a member but the invites channel was not configured.`,
			);
			await interaction.editReply({
				embeds: [
					createErrorEmbed(
						'The invites channel was not configured. Please contact modmail to solve this issue.',
					),
				],
				components: [],
			});

			return;
		}

		if (!clan) {
			this.container.logger.info(
				`[CLAN ${interaction.member.id}] ${interaction.member.user.username} tried to invite a member but they do not own a clan.`,
			);
			await interaction.editReply({
				embeds: [createErrorEmbed('You do not own a clan.')],
				components: [],
			});

			return;
		}

		if (clanMembers.size >= MAX_MEMBERS_IN_CLAN) {
			this.container.logger.info(
				`[CLAN ${interaction.member.id}] ${interaction.member.user.username} tried to invite a member but the clan already has the maximum amount of members.`,
			);
			await interaction.editReply({
				embeds: [createErrorEmbed('Your clan already has the maximum amount of members.')],
				components: [],
			});

			return;
		}

		cooldowns.set(cooldownKey, Date.now() + clanInviteCooldown);
		this.container.logger.info(
			`[CLAN ${interaction.member.id}] ${interaction.member.user.username} invited ${memberToInvite.user.username} to their clan. Sending invitation...`,
		);

		await invitesChannel
			.send({
				content: `**📨 Invitation for ${memberToInvite}**\nYou have been invited to join the clan **${clanName}**!`,
				components: [
					new ActionRowBuilder<ButtonBuilder>().addComponents(
						new ButtonBuilder()
							.setStyle(ButtonStyle.Danger)
							.setEmoji('🙅')
							.setLabel('Refuse')
							.setCustomId(`clan.invite.refuse:${memberToInvite.id}:${interaction.member.id}`),
						new ButtonBuilder()
							.setStyle(ButtonStyle.Primary)
							.setEmoji('✅')
							.setLabel('Accept')
							.setCustomId(`clan.invite.accept:${memberToInvite.id}:${interaction.member.id}`),
					),
				],
			})
			.catch((error) =>
				this.container.logger.info(
					`[CLAN ${interaction.member.id}] ${interaction.member.user.username} tried to invite ${memberToInvite.user.username} but an error occurred when trying to send invitation: ${error}`,
				),
			);

		this.container.logger.info(
			`[CLAN ${interaction.member.id}] ${interaction.member.user.username} invited ${memberToInvite.user.username} to their clan. Invitation sent, updating reply...`,
		);

		await interaction
			.editReply({
				embeds: [
					createInfoEmbed(
						`# 📨 Invitation sent\nThe invitation has been sent. You can see it in the <#${invitesChannel.id}> channel.`,
					),
				],
				components: [],
			})
			.catch((error) =>
				this.container.logger.info(
					`[CLAN ${interaction.member.id}] ${interaction.member.user.username} tried to invite ${memberToInvite.user.username} but an error occurred when trying to update the reply: ${error}`,
				),
			);

		this.container.logger.info(
			`[CLAN ${interaction.member.id}] ${interaction.member.user.username} invited ${memberToInvite.user.username} to their clan. Reply updated.`,
		);
	}

	public async kickSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		await interaction.deferReply({ ephemeral: true });

		const memberToKick = interaction.options.getMember('member');

		if (!memberToKick) {
			await interaction.editReply({
				embeds: [createErrorEmbed('The provided member could not be found.')],
			});

			return;
		}

		const clanManager = new ClanManager(interaction.member);
		const clanMemberRemoveStatus = await clanManager.removeMember(memberToKick);

		if (clanMemberRemoveStatus !== ClanMemberRemoveStatus.Removed) {
			await interaction.editReply({
				embeds: [createErrorEmbed(ClanManager.getMemberRemoveStatusMessage(clanMemberRemoveStatus))],
			});

			return;
		}

		await interaction.editReply({
			embeds: [createInfoEmbed(`# 👢 Member kicked\nThe member has been kicked from the clan.`)],
		});
	}

	public async toggleClaimSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		await interaction.deferReply({ ephemeral: true });

		const claimEnabled = interaction.options.getBoolean('enabled', true);
		const clanManager = new ClanManager(interaction.member);
		const clan = await clanManager.getClan();

		if (!clan) {
			await interaction.editReply({
				embeds: [createErrorEmbed('You do not own a clan.')],
			});

			return;
		}

		if (claimEnabled === clan.isRoleClaimable) {
			await interaction.editReply({
				embeds: [createErrorEmbed('The role is already ' + (claimEnabled ? '' : 'not ') + 'claimable.')],
			});

			return;
		}

		// Change the role claimable status
		await this.container.prisma.clan.update({
			where: { guildId_customRoleId: { guildId: clan.guildId, customRoleId: clan.customRoleId } },
			data: { isRoleClaimable: claimEnabled },
		});

		clanManager.invalidateCache('clan');

		await interaction.editReply({
			embeds: [
				createInfoEmbed(
					`# 💡 Role claimable status changed\nThe role claimable status has been changed to ${claimEnabled ? 'enabled' : 'disabled'}.`,
				),
			],
		});
	}

	public async leaveSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		await interaction.deferReply({ ephemeral: true });

		if (interaction.channel?.type !== ChannelType.GuildText) {
			await interaction.editReply({
				embeds: [createErrorEmbed('This command can only be used in a text channel.')],
			});

			return;
		}

		const clanManager = await ClanManager.fromChannel(interaction.channel);

		if (!clanManager) {
			await interaction.editReply({
				embeds: [createErrorEmbed('This channel is not a clan channel.')],
			});

			return;
		}

		const customRole = await clanManager.getCustomRole();
		const clanOwnerId = clanManager.getClanOwnerId();

		if (clanOwnerId === interaction.user.id) {
			const clanCommandId = interaction.client.application.commands.cache.find(
				(command) => command.name === 'clan',
			)?.id;
			const clanCommandMention = clanCommandId ? `</clan delete:${clanCommandId}>` : '`/clan delete`';

			await interaction.editReply({
				embeds: [
					createErrorEmbed(`You cannot leave your own clan. Did you mean to use ${clanCommandMention}?`),
				],
			});

			return;
		}

		const { context, confirmed } = await waitForButtonConfirm(
			interaction,
			`# ⚠️ WARNING\n**You are about to leave the clan "${customRole!.name}" owned by <@${clanOwnerId}>**\nYou will also lose the custom role linked to it, if you claimed it.\n\nAre you sure you want to leave the clan?`,
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
				embeds: [createInfoEmbed('Cancelled leaving the clan.')],
				components: [],
			});

			return;
		}

		await clanManager.removeMember(interaction.member);

		await newInteraction.editReply({
			content: '',
			embeds: [
				createInfoEmbed(
					`# 🚪 You left the clan\nYou have been removed from the clan "${customRole!.name}" owned by <@${clanOwnerId}>.`,
				),
			],
			components: [],
		});
	}

	public async claimRoleSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		await interaction.deferReply({ ephemeral: true });

		if (interaction.channel?.type !== ChannelType.GuildText) {
			await interaction.editReply({
				embeds: [createErrorEmbed('This command can only be used in a text channel.')],
			});

			return;
		}

		const clanManager = await ClanManager.fromChannel(interaction.channel);

		if (!clanManager) {
			await interaction.editReply({
				embeds: [createErrorEmbed('This channel is not a clan channel.')],
			});

			return;
		}

		const clan = await clanManager.getClan();

		if (!clan?.isRoleClaimable) {
			await interaction.editReply({
				embeds: [createErrorEmbed('The role is not claimable.')],
			});

			return;
		}

		const customRole = await clanManager.getCustomRole();

		if (!customRole) {
			await interaction.editReply({
				embeds: [createErrorEmbed('The custom role could not be found.')],
			});

			return;
		}

		if (interaction.member.roles.cache.has(customRole.id)) {
			await interaction.editReply({
				embeds: [createErrorEmbed('You already have the role.')],
			});

			return;
		}

		await interaction.member.roles.add(customRole.id);

		await interaction.editReply({
			embeds: [createInfoEmbed(`🎉 You have claimed the role "${customRole.name}"`)],
		});
	}

	public async unclaimRoleSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		await interaction.deferReply({ ephemeral: true });

		if (interaction.channel?.type !== ChannelType.GuildText) {
			await interaction.editReply({
				embeds: [createErrorEmbed('This command can only be used in a text channel.')],
			});

			return;
		}

		const clanManager = await ClanManager.fromChannel(interaction.channel);

		if (!clanManager) {
			await interaction.editReply({
				embeds: [createErrorEmbed('This channel is not a clan channel.')],
			});

			return;
		}

		const customRole = await clanManager.getCustomRole();

		if (!customRole) {
			await interaction.editReply({
				embeds: [createErrorEmbed('The custom role could not be found.')],
			});

			return;
		}

		if (!interaction.member.roles.cache.has(customRole.id)) {
			await interaction.editReply({
				embeds: [createErrorEmbed('You already do not have the role.')],
			});

			return;
		}

		await interaction.member.roles.remove(customRole.id);

		await interaction.editReply({
			embeds: [createInfoEmbed(`🙅 You no longer have the role "${customRole.name}"`)],
		});
	}

	public async setDescriptionSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		await interaction.deferReply({ ephemeral: true });

		const newDescription = interaction.options.getString('description', true);

		const clanManager = new ClanManager(interaction.member);
		const clan = await clanManager.getClan();

		if (!clan) {
			await interaction.editReply({
				embeds: [createErrorEmbed('You do not own a clan.')],
			});
			return;
		}

		const customRoleId = await clanManager.getCustomRoleId();
		if (clan.customRoleId !== customRoleId) {
			// This case should ideally not happen if getClan() works correctly based on member,
			// but it's a safeguard.
			await interaction.editReply({
				embeds: [createErrorEmbed('Could not verify clan ownership.')],
			});
			return;
		}

		try {
			await this.container.prisma.clan.update({
				where: {
					guildId_customRoleId: {
						guildId: clan.guildId,
						customRoleId: clan.customRoleId,
					},
				},
				data: {
					description: newDescription,
				},
			});

			clanManager.invalidateCache('clan');

			await interaction.editReply({
				embeds: [createInfoEmbed(`✅ Successfully updated your clan's description.`)],
			});

			// Optional: Trigger directory update immediately
			const task = this.container.client.stores.get('tasks').get('UpdateClanDirectory');
			if (task) {
				this.container.logger.info(
					`[CLAN SET DESCRIPTION] Triggering immediate directory update task for guild ${interaction.guildId}`,
				);
				void task.run();
			}
		} catch (error) {
			this.container.logger.error(
				`[CLAN SET DESCRIPTION] Failed to update description for clan ${clan.customRoleId} in guild ${clan.guildId}`,
				error,
			);
			await interaction.editReply({
				embeds: [
					createErrorEmbed(
						'An error occurred while trying to update the description. Please try again later.',
					),
				],
			});
		}
	}

	public async membersSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		await interaction.deferReply({ ephemeral: true });

		const clanManager = new ClanManager(interaction.member);
		const clan = await clanManager.getClan();

		if (!clan) {
			await interaction.editReply({
				embeds: [createErrorEmbed('You do not own a clan.')],
			});
			return;
		}

		const clanRole = await clanManager.getCustomRole();
		const clanName = clanRole ? clanRole.name : 'Your Clan';

		const members = await clanManager.getDiscordClanMembers();

		if (members.size === 0) {
			// This technically shouldn't happen, as the owner is always a member.
			await interaction.editReply({
				embeds: [
					createErrorEmbed(
						`You do not seem to have any members in **${clanName}** (not even yourself!). Please contact an admin.`,
					),
				],
			});
			return;
		}

		if (members.size === 1 && members.has(interaction.user.id)) {
			await interaction.editReply({
				embeds: [createInfoEmbed(`You are the only member in **${clanName}**.`)],
			});
			return;
		}

		const memberList: string[] = [];
		let count = 1;
		// Sort members to show owner first, then alphabetically
		const sortedMembers = Array.from(members.values()).sort((a, b) => {
			if (a.id === interaction.user.id) return -1;
			if (b.id === interaction.user.id) return 1;
			return a.user.tag.localeCompare(b.user.tag);
		});

		for (const member of sortedMembers) {
			const isOwner = member.id === interaction.user.id;
			memberList.push(
				`**${count++}.** ${member.user.tag} (${member.toString()})${isOwner ? ' ⭐ **(Owner)**' : ''}`,
			);
		}

		const paginatedMessage = new PaginatedMessage({
			template: createInfoEmbed(null).setTitle(`Members of ${clanName} (${members.size}/${MAX_MEMBERS_IN_CLAN})`),
		});

		const memberChunks = chunk(memberList, 10); // 10 members per page

		for (const page of memberChunks) {
			paginatedMessage.addPageEmbed((embed) => embed.setDescription(page.join('\n\n')));
		}

		await paginatedMessage.run(interaction);
	}

	public override registerApplicationCommands(registry: Subcommand.Registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName(this.name)
				.setDescription('Handle member clans.')
				.setDMPermission(false)
				.addSubcommand((subcommand) =>
					subcommand
						.setName('create')
						.setDescription('To create your clan')
						.addStringOption((option) =>
							option
								.setName('description')
								.setDescription('A short description for your clan')
								.setMinLength(1)
								.setMaxLength(150),
						),
				)
				.addSubcommand((subcommand) =>
					subcommand
						.setName('invite')
						.setDescription('To invite other members to your clan')
						.addUserOption((user) =>
							user.setName('member').setDescription('The member to invite').setRequired(true),
						),
				)
				.addSubcommand((subcommand) =>
					subcommand
						.setName('kick')
						.setDescription('To kick a member out of your clan')
						.addUserOption((user) =>
							user.setName('member').setDescription('The member to kick').setRequired(true),
						),
				)
				.addSubcommand((subcommand) =>
					subcommand
						.setName('toggle-claim')
						.setDescription('To toggle the possibility for clan members to claim the custom role.')
						.addBooleanOption((option) =>
							option
								.setName('enabled')
								.setDescription(
									'Whether or not the members of the clan should be able to claim the custom role.',
								)
								.setRequired(true),
						),
				)
				.addSubcommand((subcommand) => subcommand.setName('delete').setDescription('To delete your clan'))
				.addSubcommand((subcommand) =>
					subcommand.setName('leave').setDescription('To leave the clan that owns the current text channel.'),
				)
				.addSubcommand((subcommand) =>
					subcommand
						.setName('claim-role')
						.setDescription(
							'To claim the custom role linked to the clan that owns the current text channel.',
						),
				)
				.addSubcommand((subcommand) =>
					subcommand
						.setName('unclaim-role')
						.setDescription(
							'To claim the custom role linked to the clan that owns the current text channel.',
						),
				)
				.addSubcommand((subcommand) =>
					subcommand
						.setName('set-description')
						.setDescription('Updates the description of your clan.')
						.addStringOption((option) =>
							option
								.setName('description')
								.setDescription('The new description for your clan (max 100 characters)')
								.setMinLength(1)
								.setMaxLength(100)
								.setRequired(true),
						),
				)
				.addSubcommand((subcommand) =>
					subcommand
						.setName('toggle-directory')
						.setDescription('Toggles whether your clan appears in the clan directory listing.'),
				)
				.addSubcommand((subcommand) =>
					subcommand.setName('members').setDescription('Lists all members currently in your clan.'),
				),
		);
	}

	public async toggleDirectorySubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		await interaction.deferReply({ ephemeral: true });

		const clanManager = new ClanManager(interaction.member);
		const clan = await clanManager.getClan();

		if (!clan) {
			await interaction.editReply({
				embeds: [createErrorEmbed('You do not own a clan.')],
			});
			return;
		}

		const customRoleId = await clanManager.getCustomRoleId();
		if (clan.customRoleId !== customRoleId) {
			await interaction.editReply({
				embeds: [createErrorEmbed('Could not verify clan ownership.')],
			});
			return;
		}

		const newVisibilityState = !clan.isVisibleInDirectory;

		try {
			await this.container.prisma.clan.update({
				where: {
					guildId_customRoleId: {
						guildId: clan.guildId,
						customRoleId: clan.customRoleId,
					},
				},
				data: {
					isVisibleInDirectory: newVisibilityState,
				},
			});

			clanManager.invalidateCache('clan');

			await interaction.editReply({
				embeds: [
					createInfoEmbed(
						`✅ Your clan will now be ${newVisibilityState ? '**visible**' : '**hidden**'} in the directory. The change will appear after the next update.`,
					),
				],
			});

			// Trigger directory update immediately / Optional
			const task = this.container.client.stores.get('tasks').get('UpdateClanDirectory');
			if (task) {
				this.container.logger.info(
					`[CLAN TOGGLE DIRECTORY] Triggering immediate directory update task for guild ${interaction.guildId}`,
				);
				void task.run();
			}
		} catch (error) {
			this.container.logger.error(
				`[CLAN TOGGLE DIRECTORY] Failed to update visibility for clan ${clan.customRoleId} in guild ${clan.guildId}`,
				error,
			);
			await interaction.editReply({
				embeds: [
					createErrorEmbed(
						'An error occurred while trying to update the directory visibility. Please try again later.',
					),
				],
			});
		}
	}
}
