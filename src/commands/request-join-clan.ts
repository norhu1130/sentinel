import { ApplyOptions } from '@sapphire/decorators';
import { Command } from '@sapphire/framework';
// Import ApplicationCommandOptionChoiceData from discord.js instead of sapphire
import {
	ActionRowBuilder,
	AutocompleteInteraction,
	ButtonBuilder,
	ButtonStyle,
	ChatInputCommandInteraction,
	EmbedBuilder,
	PermissionsBitField,
	type ApplicationCommandOptionChoiceData,
} from 'discord.js';
// Import MAX_MEMBERS_IN_CLAN
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
	// Add return type Promise<void> and remove unnecessary returns
	public override async chatInputRun(interaction: ChatInputCommandInteraction<'cached'>): Promise<void> {
		await interaction.deferReply({ ephemeral: true });

		const targetClanRoleId = interaction.options.getString('clan', true);
		const userMessage = interaction.options.getString('message');
		const requester = interaction.member;

		// --- Basic Checks ---
		const targetClanRole = await interaction.guild.roles.fetch(targetClanRoleId).catch(() => null);
		if (!targetClanRole) {
			await interaction.editReply({ embeds: [createErrorEmbed('The specified clan role could not be found.')] });
			return; // Exit early on error
		}

		const clan = await this.container.prisma.clan.findUnique({
			where: { guildId_customRoleId: { guildId: interaction.guildId, customRoleId: targetClanRole.id } },
			include: { members: true },
		});

		if (!clan) {
			await interaction.editReply({ embeds: [createErrorEmbed('That role does not seem to belong to a clan.')] });
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

		// Use imported constant
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
			const remainingSeconds = Math.ceil((cooldownExpires - now) / 1000);
			await interaction.editReply({
				embeds: [
					createErrorEmbed(`You can send another request to this clan owner in ${remainingSeconds} seconds.`),
				],
			});
			return;
		}

		try {
			const embed = new EmbedBuilder()
				.setColor(targetClanRole.color || 'Blurple')
				.setTitle(`📥 Clan Join Request: ${targetClanRole.name}`)
				.setDescription(`${requester.user.tag} (${requester.toString()}) has requested to join your clan.`)
				.setThumbnail(requester.user.displayAvatarURL())
				// Use imported constant
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

			let sentViaDm = true;
			await clanOwnerMember.send({ embeds: [embed], components: [row] }).catch(async (dmError) => {
				sentViaDm = false;
				this.container.logger.warn(
					`[CLAN JOIN REQ] Failed to DM clan owner ${clanOwnerMember.user.tag} (${clanOwnerMember.id}). Error: ${dmError.message}. Trying clan channel.`,
				);
				const clanManager = new ClanManager(clanOwnerMember);
				const clanChannel = await clanManager.getClanChannel();

				// Check if bot exists in guild.members.me before accessing permissions
				const meMember = interaction.guild.members.me;
				if (
					clanChannel &&
					meMember &&
					clanChannel.permissionsFor(meMember)?.has(PermissionsBitField.Flags.SendMessages)
				) {
					await clanChannel.send({
						content: `${clanOwnerMember.toString()}, you have a new join request:`,
						embeds: [embed],
						components: [row],
					});
				} else {
					this.container.logger.error(
						`[CLAN JOIN REQ] Failed to send request to clan owner ${clanOwnerMember.user.tag} via DM and could not send to clan channel ${clanChannel?.id ?? 'N/A'}. Bot member found: ${!!meMember}`,
					);
					throw new Error(
						'Could not notify the clan owner. Their DMs might be closed, and I might lack permission to send messages in their clan channel.',
					);
				}
			});

			requestCooldowns.set(cooldownKey, now + COOLDOWN_DURATION);

			await interaction.editReply({
				embeds: [
					createInfoEmbed(
						`✅ Your request to join **${targetClanRole.name}** has been sent ${sentViaDm ? 'to the clan owner' : 'in the clan channel'}.`,
					),
				],
			});
		} catch (error: any) {
			this.container.logger.error(
				`[CLAN JOIN REQ] Error sending request from ${requester.user.tag} to clan ${targetClanRole.name}`,
				error,
			);
			// Don't return here, just edit the reply
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

			// Fetch all roles once
			const allRoles = await interaction.guild.roles.fetch();

			const clanRoles = allRoles.filter((role) => visibleClans.some((clan) => clan.customRoleId === role.id));

			const options: ApplicationCommandOptionChoiceData[] = [];
			const addedRoles = new Set<string>();

			// Prioritize matches
			for (const role of clanRoles.values()) {
				if (options.length >= 25) break;
				if (addedRoles.has(role.id)) continue;

				if (role.name.toLowerCase().includes(input)) {
					options.push({ name: trimPretty(role.name, 97), value: role.id });
					addedRoles.add(role.id);
				}
			}
			// Add remaining if space allows
			for (const role of clanRoles.values()) {
				if (options.length >= 25) break;
				if (addedRoles.has(role.id)) continue;

				options.push({ name: trimPretty(role.name, 97), value: role.id });
				addedRoles.add(role.id);
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
				.setName('request-join-clan') // Changed name slightly for clarity
				.setDescription(this.description)
				.setDMPermission(false)
				.addStringOption((option) =>
					option
						.setName('clan')
						.setDescription('The name or ID of the clan you want to join.') // Updated description
						.setRequired(true)
						.setAutocomplete(true),
				)
				.addStringOption((option) =>
					option
						.setName('message')
						.setDescription('An optional message to send with your request.')
						.setMaxLength(200)
						.setRequired(false),
				),
		);
	}
}
