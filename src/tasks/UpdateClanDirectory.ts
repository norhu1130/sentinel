//import { container } from '@sapphire/framework';
import type { GuildTextBasedChannel, Message, Role } from 'discord.js';
import { EmbedBuilder } from 'discord.js';
import { MAX_MEMBERS_IN_CLAN } from '../lib/abilities/ClanManager.js'; // Removed ClanManager import as we don't need the instance here
import { Task } from '../lib/schedule/tasks/Task.js';
import { createInfoEmbed } from '../lib/utils/createEmbed.js';
// Removed fetchReadableUser as we only need the ID mention format

const header = '[CLAN DIRECTORY] ';
const clansPerPage = 10; 
export class UpdateClanDirectory extends Task {
	public async run() {
		this.container.logger.info(`${header}Starting clan directory update...`);

		// Fetch all clans including their members to get the count
		const allClans = await this.container.prisma.clan.findMany({
			include: { members: true },
		});

		if (allClans.length === 0) {
			this.container.logger.info(`${header}No clans found to process.`);
			return null; 
		}

		
		const clansByGuild = allClans.reduce((map, clan) => {
			const clans = map.get(clan.guildId) ?? [];
			clans.push(clan);
			map.set(clan.guildId, clans);
			return map;
		}, new Map<string, typeof allClans>());

		
		for (const [guildId, clans] of clansByGuild.entries()) {
			const guild = this.container.client.guilds.cache.get(guildId);
			if (!guild) {
				this.container.logger.warn(`${header}Skipping guild ${guildId}: Guild not found in cache.`);
				continue; 
			}

			
			const config = await this.container.prisma.premiumGuildRoleConfig.findFirst({
				where: { guildId },
			});

			
			if (!config?.clanDirectoryChannelId || !config.clanDirectoryMessageId) {
				this.container.logger.debug(
					`${header}Skipping guild ${guild.name} (${guildId}): Directory channel or message ID not configured.`,
				);
				continue;
			}

			const channel = (await guild.channels
				.fetch(config.clanDirectoryChannelId)
				.catch(() => null)) as GuildTextBasedChannel | null;

			
			if (!channel || !channel.isTextBased()) {
				this.container.logger.warn(
					`${header}Skipping guild ${guild.name} (${guildId}): Directory channel ${config.clanDirectoryChannelId} not found or is not a text channel.`,
				);
				continue;
			}

			
			let message: Message | null = null;
			try {
				// Tries to fetch using the ID from the DB
				message = await channel.messages.fetch(config.clanDirectoryMessageId);
			} catch {
				
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

			
			const allClansData: ClanDirectoryData[] = [];
			for (const clan of clans) {
				
				const clanRole = (await guild.roles.fetch(clan.customRoleId).catch(() => null)) as Role | null;
				if (!clanRole) {
					this.container.logger.warn(
						`${header}Clan role ${clan.customRoleId} not found for clan in guild ${guild.name} (${guildId}). Skipping this clan.`,
					);
					continue; 
				}

				
				const premiumMember = await this.container.prisma.premiumMember.findFirst({
					where: { guildId: clan.guildId, customRoleId: clan.customRoleId },
				});

				allClansData.push({
					name: clanRole.name,
					description: clan.description ?? 'No description set.', 
					memberCount: clan.members.length,
					ownerId: premiumMember?.userId, 
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

			if (embeds.length === 0) {
				embeds.push(EmbedBuilder.from(baseEmbed).setDescription('There are currently no clans to display.'));
			}

			try {
				await message.edit({
					content: `*Last updated: <t:${Math.floor(Date.now() / 1000)}:R>*`, 
					embeds: [embeds[0]], 
					components: [], 
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
		} 

		this.container.logger.info(`${header}Finished clan directory update task.`);
		return null; 
	}

	/** Formats a single clan's data into a string for the embed. */
	private formatClanEntry(data: ClanDirectoryData, index: number): string {
		const rank = ''; 
		const ownerMention = data.ownerId ? `<@${data.ownerId}>` : '`Unknown Owner`'; // Use mention or fallback text

		
		const description = data.description
			.split('\n')
			.map((line) => `> ${line}`)
			.join('\n');

		return [
			`**${index}. ${data.name}** ${rank}`, 
			`   └─ Owner: ${ownerMention} | Members: **${data.memberCount}**/${MAX_MEMBERS_IN_CLAN}`, // Owner and member count
			description, 
		].join('\n');
	}
}


interface ClanDirectoryData {
	name: string;
	description: string;
	memberCount: number;
	ownerId?: string | null;
}
