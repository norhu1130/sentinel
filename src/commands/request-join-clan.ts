import { ApplyOptions } from '@sapphire/decorators';
import { Command } from '@sapphire/framework';
import {
	ActionRowBuilder,
	AutocompleteInteraction,
	ButtonBuilder,
	ButtonStyle,
	ChatInputCommandInteraction,
	EmbedBuilder,
	InteractionContextType, // Added this import
	PermissionsBitField,
	type ApplicationCommandOptionChoiceData,
	time,
	TimestampStyles,
} from 'discord.js';
import { ClanManager, MAX_MEMBERS_IN_CLAN } from '../lib/abilities/ClanManager.js';
import { createErrorEmbed, createInfoEmbed } from '../lib/utils/createEmbed.js';
import { makeClanJoinRequestId } from '../interaction-handlers/clan-join-request.js';
import { trimPretty } from '../lib/utils/trim.js';

// Simple cooldown map (in-memory)
const requestCooldowns = new Map<string, number>(); // Key: requesterId-clanOwnerId, Value: timestamp when cooldown expires
const COOLDOWN_DURATION = 15 * 60 * 1000; // 15 minutes in milliseconds

@ApplyOptions<Command.Options>({
	description: 'Requests to join a specific clan.',
})
export class RequestJoinClanCommand extends Command {
	public override async chatInputRun(interaction: ChatInputCommandInteraction<'cached'>): Promise<void> {
		await interaction.deferReply({ ephemeral: true });

		const targetClanRoleId = interaction.options.getString('clan', true);

		// check for '__NONE__'
		if (targetClanRoleId === '__NONE__') {
			await interaction.editReply({
				embeds: [
					createErrorEmbed(
						'No visible clans matched your search. The clan you are looking for might be private or does not exist.',
					),
				],
			});
			return;
		}

		const userMessage = interaction.options.getString('message');
		const requester = interaction.member;

		// --- Basic Checks ---
		const targetClanRole = await interaction.guild.roles.fetch(targetClanRoleId).catch(() => null);
		if (!targetClanRole) {
			await interaction.editReply({ embeds: [createErrorEmbed('The specified clan role could not be found.')] });
			return;
		}

		const clan = await this.container.prisma.clan.findUnique({
			where: { guildId_customRoleId: { guildId: interaction.guildId, customRoleId: targetClanRole.id } },
			include: { members: true },
		});

		if (!clan) {
			await interaction.editReply({ embeds: [createErrorEmbed('This does not seem to be a valid clan.')] });
			return;
		}

		const premiumOwner = await this.container.prisma.premiumMember.findFirst({
			where: { guildId: clan.guildId, customRoleId: clan.customRoleId },
		});

		if (!premiumOwner || !premiumOwner.userId) {
			this.container.logger.error(
				`[CLAN JOIN REQ] Could not find owner for clan role ${clan.customRoleId} in guild ${clan.guildId}`,
			);
			await interaction.editReply({ embeds: [createErrorEmbed('Could not find the owner of that clan.')] });
			return;
		}

		const clanOwnerMember = await interaction.guild.members.fetch(premiumOwner.userId).catch(() => null);
		if (!clanOwnerMember) {
			await interaction.editReply({
				embeds: [createErrorEmbed('The owner of that clan does not seem to be in the server anymore.')],
			});
			return;
		}

		if (requester.id === clanOwnerMember.id) {
			await interaction.editReply({ embeds: [createErrorEmbed('You cannot request to join your own clan.')] });
			return;
		}

		if (clan.members.some((m) => m.userId === requester.id)) {
			await interaction.editReply({
				embeds: [createErrorEmbed(`You are already a member of **${targetClanRole.name}**.`)],
			});
			return;
		}

		const existingMembership = await this.container.prisma.clanMember.findFirst({
			where: { userId: requester.id, clanGuildId: interaction.guildId },
		});
		if (existingMembership) {
			const existingClan = await this.container.prisma.clan.findUnique({
				where: {
					guildId_customRoleId: {
						guildId: existingMembership.clanGuildId,
						customRoleId: existingMembership.clanCustomRoleId,
					},
				},
			});
			const existingClanRole =
				existingClan ? await interaction.guild.roles.fetch(existingClan.customRoleId).catch(() => null) : null;
			const clanName = existingClanRole ? `**${existingClanRole.name}**` : 'another clan';
			await interaction.editReply({
				embeds: [
					createErrorEmbed(
						`You are already a member of ${clanName}. Leave it before requesting to join another.`,
					),
				],
			});
			return;
		}

		if (clan.members.length >= MAX_MEMBERS_IN_CLAN) {
			await interaction.editReply({
				embeds: [createErrorEmbed(`Sorry, **${targetClanRole.name}** is currently full.`)],
			});
			return;
		}

		const cooldownKey = `${requester.id}-${clanOwnerMember.id}`;
		const now = Date.now();
		const cooldownExpires = requestCooldowns.get(cooldownKey) ?? 0;

		if (now < cooldownExpires) {
			const cooldownTimestamp = Math.floor(cooldownExpires / 1000);
			await interaction.editReply({
				embeds: [
					createErrorEmbed(
						`You can send another request to this clan owner ${time(cooldownTimestamp, TimestampStyles.RelativeTime)}.`,
					),
				],
			});
			return;
		}

		// --- Get Clan Channel ---
		const clanManager = new ClanManager(clanOwnerMember);
		const clanChannel = await clanManager.getClanChannel();

		if (!clanChannel) {
			this.container.logger.error(
				`[CLAN JOIN REQ] Clan channel not found for clan ${clan.customRoleId} in guild ${clan.guildId}`,
			);
			await interaction.editReply({
				embeds: [createErrorEmbed('The clan channel could not be found. Please contact modmail.')],
			});
			return;
		}

		// Check bot permissions in clan channel
		const me = interaction.guild.members.me;
		if (!me || !clanChannel.permissionsFor(me)?.has(PermissionsBitField.Flags.SendMessages)) {
			this.container.logger.error(
				`[CLAN JOIN REQ] Bot lacks SendMessages permission in clan channel ${clanChannel.id} for guild ${clan.guildId}`,
			);
			await interaction.editReply({
				embeds: [
					createErrorEmbed(
						'I do not have permission to send messages in the clan channel. Please contact modmail.',
					),
				],
			});
			return;
		}

		// --- Send Request in Clan Channel ---
		try {
			const embed = new EmbedBuilder()
				.setColor(targetClanRole.color || 'Blurple')
				.setTitle(`📥 Clan Join Request: ${targetClanRole.name}`)
				.setDescription(
					`<@${premiumOwner.userId}>, ${requester.user.tag} (${requester.toString()}) has requested to join your clan.`,
				)
				.setThumbnail(requester.displayAvatarURL())
				.addFields({ name: 'Members', value: `${clan.members.length}/${MAX_MEMBERS_IN_CLAN}`, inline: true })
				.setTimestamp();

			if (userMessage) {
				embed.addFields({ name: 'Message', value: userMessage });
			}

			const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder()
					.setCustomId(makeClanJoinRequestId('deny', requester.id, clanOwnerMember.id, clan.customRoleId))
					.setLabel('Deny')
					.setStyle(ButtonStyle.Danger)
					.setEmoji('❌'),
				new ButtonBuilder()
					.setCustomId(makeClanJoinRequestId('accept', requester.id, clanOwnerMember.id, clan.customRoleId))
					.setLabel('Accept')
					.setStyle(ButtonStyle.Success)
					.setEmoji('✅'),
			);

			await clanChannel.send({ embeds: [embed], components: [row] });

			this.container.logger.info(
				`[CLAN JOIN REQ] Sent join request from ${requester.id} to clan channel ${clanChannel.id} for clan ${targetClanRole.name}`,
			);

			requestCooldowns.set(cooldownKey, now + COOLDOWN_DURATION);

			await interaction.editReply({
				embeds: [
					createInfoEmbed(
						`✅ Your request to join **${targetClanRole.name}** has been sent in the clan channel.`,
					),
				],
			});
		} catch (error: any) {
			this.container.logger.error(
				`[CLAN JOIN REQ] Error sending request from ${requester.user.tag} to clan channel for ${targetClanRole.name}`,
				error,
			);
			await interaction.editReply({
				embeds: [createErrorEmbed(`Could not send the join request: ${error.message}`)],
			});
		}
	}

	public override async autocompleteRun(interaction: AutocompleteInteraction<'cached'>) {
		const focusedOption = interaction.options.getFocused(true);
		const input = focusedOption.value.toLowerCase();

		if (focusedOption.name === 'clan') {
			const visibleClans = await this.container.prisma.clan.findMany({
				where: { guildId: interaction.guildId, isVisibleInDirectory: true },
				take: 25,
			});

			if (!visibleClans.length) {
				return interaction.respond([{ name: 'No visible clans found', value: '__NONE__' }]);
			}

			const allRoles = await interaction.guild.roles.fetch();
			const clanRoles = allRoles.filter((role) => visibleClans.some((clan) => clan.customRoleId === role.id));

			const options: ApplicationCommandOptionChoiceData[] = [];
			const addedRoles = new Set<string>();

			// Prioritize matches
			for (const role of clanRoles.values()) {
				if (options.length >= 25) break;
				if (addedRoles.has(role.id)) continue;

				if (role.name.toLowerCase().includes(input) || role.id == input) {
					options.push({ name: trimPretty(role.name, 97), value: role.id });
					addedRoles.add(role.id);
				}
			}

			// Sort alphabetically for better UX
			options.sort((a, b) => a.name.localeCompare(b.name));

			return interaction.respond(options);
		}

		return interaction.respond([]);
	}

	public override registerApplicationCommands(registry: Command.Registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName('request-join-clan')
				.setDescription(this.description)
				.setContexts(InteractionContextType.Guild) // Changed this line
				.addStringOption((option) =>
					option
						.setName('clan')
						.setDescription('The name or ID of the clan you want to join.')
						.setRequired(true)
						.setAutocomplete(true),
				)
				.addStringOption((option) =>
					option
						.setName('message')
						.setDescription('An optional message to send with your request.')
						.setMaxLength(1000)
						.setRequired(false),
				),
		);
	}
}
