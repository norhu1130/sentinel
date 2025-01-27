import { Subcommand, type SubcommandMappingArray } from '@sapphire/plugin-subcommands';
import { ChannelType } from 'discord-api-types/v10';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Collection, type MessageComponentInteraction } from 'discord.js';
import {
	ClanCreationStatus,
	ClanDeletionStatus,
	ClanManager,
	ClanMemberRemoveStatus,
	MAX_MEMBERS_IN_CLAN,
} from '../../../lib/abilities/ClanManager.js';
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
	];

	public async createSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		await interaction.deferReply({ ephemeral: true });

		const clanManager = new ClanManager(interaction.member);
		const clanCreationStatus = await clanManager.createClan();

		if (clanCreationStatus !== ClanCreationStatus.Created) {
			let errorMessage = '';

			switch (clanCreationStatus) {
				case ClanCreationStatus.CategoryNotConfigured:
					errorMessage = 'The clan category has not been set. Please contact modmail to solve this issue.';
					break;

				case ClanCreationStatus.NotAble:
					errorMessage = 'You do not have the ability to create a clan.';
					break;

				case ClanCreationStatus.AbleButNoCustomRole:
					errorMessage = 'You need to create your own custom role before you can create a clan.';
					break;

				case ClanCreationStatus.CustomRoleNotFound:
					errorMessage = 'Your custom role could not be found. Please contact modmail to solve this issue.';
					break;

				case ClanCreationStatus.ExistingClanFound:
					errorMessage = 'You already own a clan, you cannot create a second one.';
					break;

				case ClanCreationStatus.CouldNotCreateClanChannel:
					errorMessage = 'The clan channel could not be created. Please contact modmail to solve this issue.';
					break;
			}

			await interaction.editReply({
				embeds: [createErrorEmbed(errorMessage)],
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
			let errorMessage = '';

			switch (clanDeletionStatus) {
				case ClanDeletionStatus.ClanNotFound:
					errorMessage = 'You do not own a clan.';
					break;

				case ClanDeletionStatus.ClanChannelNotFound:
					errorMessage = 'The clan channel could not be found. Please contact modmail to solve this issue.';
					break;

				case ClanDeletionStatus.CouldNotDeleteClanChannel:
					errorMessage = 'The clan channel could not be deleted. Please contact modmail to solve this issue.';
					break;
			}

			this.container.logger.error(
				`[CLAN] ${interaction.member.user.username} failed to delete clan: ${errorMessage}`,
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
				`[CLAN] ${interaction.member.user.username} tried to invite a member but the provided member was not found.`,
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
				`[CLAN] ${interaction.member.user.username} tried to invite a member but they were on cooldown.`,
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
				`[CLAN] ${interaction.member.user.username} tried to invite a member but the invites channel was not configured.`,
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
				`[CLAN] ${interaction.member.user.username} tried to invite a member but they do not own a clan.`,
			);
			await interaction.editReply({
				embeds: [createErrorEmbed('You do not own a clan.')],
				components: [],
			});

			return;
		}

		if (clanMembers.size >= MAX_MEMBERS_IN_CLAN) {
			this.container.logger.info(
				`[CLAN] ${interaction.member.user.username} tried to invite a member but the clan already has the maximum amount of members.`,
			);
			await interaction.editReply({
				embeds: [createErrorEmbed('Your clan already has the maximum amount of members.')],
				components: [],
			});

			return;
		}

		cooldowns.set(cooldownKey, Date.now() + clanInviteCooldown);
		this.container.logger.info(
			`[CLAN] ${interaction.member.user.username} invited ${memberToInvite.user.username} to their clan. Sending invitation...`,
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
					`[CLAN] ${interaction.member.user.username} tried to invite ${memberToInvite.user.username} but an error occurred when trying to send invitation: ${error}`,
				),
			);

		this.container.logger.info(
			`[CLAN] ${interaction.member.user.username} invited ${memberToInvite.user.username} to their clan. Invitation sent, updating reply...`,
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
					`[CLAN] ${interaction.member.user.username} tried to invite ${memberToInvite.user.username} but an error occurred when trying to update the reply: ${error}`,
				),
			);

		this.container.logger.info(
			`[CLAN] ${interaction.member.user.username} invited ${memberToInvite.user.username} to their clan. Reply updated.`,
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
			let errorMessage = '';

			switch (clanMemberRemoveStatus) {
				case ClanMemberRemoveStatus.NotInClan:
					errorMessage = 'The provided member is not in your clan.';
					break;
			}

			await interaction.editReply({
				embeds: [createErrorEmbed(errorMessage)],
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
		const clanOwner = clanManager.getClanOwner();

		const { context, confirmed } = await waitForButtonConfirm(
			interaction,
			`# ⚠️ WARNING\n**You are about to leave the clan "${customRole!.name}" owned by ${clanOwner}**\nYou will also lose the custom role linked to it, if you claimed it.\n\nAre you sure you want to leave the clan?`,
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
					`# 🚪 You left the clan\nYou have been removed from the clan "${customRole!.name}" owned by ${clanOwner}.`,
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

	public override registerApplicationCommands(registry: Subcommand.Registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName(this.name)
				.setDescription('Handle member clans.')
				.setDMPermission(false)
				.addSubcommand((subcommand) => subcommand.setName('create').setDescription('To create your clan'))
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
				),
		);
	}
}
