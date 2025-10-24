//import { container } from '@sapphire/framework';
import type { GuildTextBasedChannel, Message, Role } from 'discord.js';
import { EmbedBuilder } from 'discord.js';
import { MAX_MEMBERS_IN_CLAN } from '../lib/abilities/ClanManager.js'; // Removed ClanManager import as we don't need the instance here
import { Task } from '../lib/schedule/tasks/Task.js';
import { createInfoEmbed } from '../lib/utils/createEmbed.js';
// Removed fetchReadableUser as we only need the ID mention format

const header = '[CLAN DIRECTORY] ';
const clansPerPage = 10; // Number of clans to show per embed page

export class UpdateClanDirectory extends Task {
	public async run() {
		this.container.logger.info(`${header}Starting clan directory update...`);

		// Fetch all clans including their members to get the count
		const allClans = await this.container.prisma.clan.findMany({
			include: { members: true },
		});

		if (allClans.length === 0) {
			this.container.logger.info(`${header}No clans found to process.`);
			return null; // No clans, nothing to do
		}

		// Group clans by guild ID for efficient processing
		const clansByGuild = allClans.reduce((map, clan) => {
			const clans = map.get(clan.guildId) ?? [];
			clans.push(clan);
			map.set(clan.guildId, clans);
			return map;
		}, new Map<string, typeof allClans>());

		// Process each guild that has clans
		for (const [guildId, clans] of clansByGuild.entries()) {
			const guild = this.container.client.guilds.cache.get(guildId);
			if (!guild) {
				this.container.logger.warn(`${header}Skipping guild ${guildId}: Guild not found in cache.`);
				continue; // Skip if guild isn't cached (bot might not be in it anymore)
			}

			// Fetch the guild's specific configuration for the directory
			const config = await this.container.prisma.premiumGuildRoleConfig.findFirst({
				where: { guildId },
			});

			// Skip if the directory channel or message ID isn't configured
			if (!config?.clanDirectoryChannelId || !config.clanDirectoryMessageId) {
				this.container.logger.debug(
					`${header}Skipping guild ${guild.name} (${guildId}): Directory channel or message ID not configured.`,
				);
				continue;
			}

			// Fetch the configured directory channel
			const channel = (await guild.channels
				.fetch(config.clanDirectoryChannelId)
				.catch(() => null)) as GuildTextBasedChannel | null;

			// Validate the channel exists and is a text-based channel
			if (!channel || !channel.isTextBased()) {
				this.container.logger.warn(
					`${header}Skipping guild ${guild.name} (${guildId}): Directory channel ${config.clanDirectoryChannelId} not found or is not a text channel.`,
				);
				continue;
			}

			// Fetch the specific message designated for the directory
			let message: Message | null = null;
			try {
				// Tries to fetch using the ID from the DB
				message = await channel.messages.fetch(config.clanDirectoryMessageId);
			} catch {
				// If fetch fails (message deleted, etc.)
				this.container.logger.warn(
					`${header}Directory message ${config.clanDirectoryMessageId} not found... Attempting to recreate.`,
				);
				try {
					// Send a new one
					message = await channel.send({ embeds: [createInfoEmbed('Clan Directory is initializing...')] });
					// Update the DB with the NEW message ID
					await this.container.prisma.premiumGuildRoleConfig.update({
						where: { guildId },
						data: { clanDirectoryMessageId: message.id },
					});
					this.container.logger.info(`${header}Recreated directory message with new ID: ${message.id}...`);
				} catch (error) {
					// If sending the new message fails, log and skip this guild
					this.container.logger.error(
						`${header}Failed to recreate directory message for guild ${guild.name} (${guildId})`,
						error,
					);
					continue;
				}
			}

			// Prepare data for formatting
			const allClansData: ClanDirectoryData[] = [];
			for (const clan of clans) {
				// Fetch the associated role to get the clan name
				const clanRole = (await guild.roles.fetch(clan.customRoleId).catch(() => null)) as Role | null;
				if (!clanRole) {
					this.container.logger.warn(
						`${header}Clan role ${clan.customRoleId} not found for clan in guild ${guild.name} (${guildId}). Skipping this clan.`,
					);
					continue; // Skip this clan if its role is gone
				}

				// Find the owner's user ID from the PremiumMember table
				const premiumMember = await this.container.prisma.premiumMember.findFirst({
					where: { guildId: clan.guildId, customRoleId: clan.customRoleId },
				});

				allClansData.push({
					name: clanRole.name,
					description: clan.description ?? 'No description set.', // Use default if null
					memberCount: clan.members.length,
					ownerId: premiumMember?.userId, // Owner ID might be null if data is inconsistent
				});
			}

			// Sort clans (e.g., by member count descending)
			allClansData.sort((a, b) => b.memberCount - a.memberCount);

			// Format clan entries
			const clanEntries = allClansData.map((data, index) => this.formatClanEntry(data, index + 1));

			// Manually chunk the entries into embed descriptions
			const embeds: EmbedBuilder[] = [];
			const baseEmbed = createInfoEmbed(null).setTitle(`✨ ${guild.name} Clan Directory ✨`);

			if (clanEntries.length === 0) {
				embeds.push(EmbedBuilder.from(baseEmbed).setDescription('There are currently no clans to display.'));
			} else {
				// Manually chunk the entries
				for (let i = 0; i < clanEntries.length; i += clansPerPage) {
					const chunk = clanEntries.slice(i, i + clansPerPage);
					embeds.push(
						EmbedBuilder.from(baseEmbed)
							.setDescription(chunk.join('\n\n')) // Join the strings for the description
							.setFooter({
								text: `Page ${Math.floor(i / clansPerPage) + 1} of ${Math.ceil(clanEntries.length / clansPerPage)} | Total Clans: ${allClansData.length}`,
							}),
					);
				}
			}

			// Ensure we have at least one embed, even if empty
			if (embeds.length === 0) {
				embeds.push(EmbedBuilder.from(baseEmbed).setDescription('There are currently no clans to display.'));
			}

			// Edit the existing message with the first page of the directory
			// Note: This simple implementation only updates with the first page.
			// For full pagination, you'd typically add buttons and handle interactions.
			try {
				await message.edit({
					content: `*Last updated: <t:${Math.floor(Date.now() / 1000)}:R>*`, // Add a relative timestamp
					embeds: [embeds[0]], // Send only the first page
					components: [], // Clear any previous components
				});
				this.container.logger.info(
					`${header}Successfully updated directory message ${config.clanDirectoryMessageId} for guild ${guild.name} (${guildId}).`,
				);
			} catch (error) {
				this.container.logger.error(
					`${header}Failed to edit clan directory message ${config.clanDirectoryMessageId} for guild ${guild.name} (${guildId})`,
					error,
				);
			}
		} // End of guild loop

		this.container.logger.info(`${header}Finished clan directory update task.`);
		return null; // Indicate successful run for a recurring task
	}

	/** Formats a single clan's data into a string for the embed. */
	private formatClanEntry(data: ClanDirectoryData, index: number): string {
		const rank = ''; // Placeholder for future points/rank system
		const ownerMention = data.ownerId ? `<@${data.ownerId}>` : '`Unknown Owner`'; // Use mention or fallback text

		// Using block quotes for description for better visual separation
		const description = data.description
			.split('\n')
			.map((line) => `> ${line}`)
			.join('\n');

		return [
			`**${index}. ${data.name}** ${rank}`, // Clan name and rank
			`   └─ Owner: ${ownerMention} | Members: **${data.memberCount}**/${MAX_MEMBERS_IN_CLAN}`, // Owner and member count
			description, // Description
		].join('\n');
	}
}

/** Interface defining the structure of data needed to format a clan entry. */
interface ClanDirectoryData {
	name: string;
	description: string;
	memberCount: number;
	ownerId?: string | null; // Owner ID can be null or undefined
}
