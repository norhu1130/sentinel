//import { container } from '@sapphire/framework';
import type { GuildTextBasedChannel, Message, Role } from 'discord.js';
import { EmbedBuilder } from 'discord.js';
import { MAX_MEMBERS_IN_CLAN } from '../lib/abilities/ClanManager.js';
import { Task } from '../lib/schedule/tasks/Task.js';
import { createInfoEmbed } from '../lib/utils/createEmbed.js';

const header = '[CLAN DIRECTORY] ';
const clansPerPage = 10;
export class UpdateClanDirectory extends Task {
	public async run() {
		this.container.logger.info(`${header}Starting clan directory update...`);

		const visibleClans = await this.container.prisma.clan.findMany({
			where: { isVisibleInDirectory: true }, // Filter for visible clans
			include: { members: true }, // Include members to get the count
		});
		this.container.logger.info(`${header}Fetched ${visibleClans.length} visible clans from DB.`);

		const clansByGuild = visibleClans.reduce((map, clan) => {
			const clans = map.get(clan.guildId) ?? [];
			clans.push(clan);
			map.set(clan.guildId, clans);
			return map;
		}, new Map<string, typeof visibleClans>());
		this.container.logger.info(`${header}Grouped visible clans into ${clansByGuild.size} guilds.`);

		const allConfiguredGuilds = await this.container.prisma.premiumGuildRoleConfig.findMany({
			where: { clanDirectoryChannelId: { not: null }, clanDirectoryMessageId: { not: null } },
			select: { guildId: true },
		});
		this.container.logger.info(`${header}Found ${allConfiguredGuilds.length} guilds with directory configuration.`);

		for (const configuredGuild of allConfiguredGuilds) {
			const guildId = configuredGuild.guildId;
			const clans = clansByGuild.get(guildId) ?? [];
			this.container.logger.info(
				`${header}Processing configured guild ${guildId}. Found ${clans.length} visible clans for it.`,
			);

			const guild = this.container.client.guilds.cache.get(guildId);
			if (!guild) {
				this.container.logger.warn(`${header}Skipping guild ${guildId}: Guild not found in cache.`);
				continue;
			}

			const config = await this.container.prisma.premiumGuildRoleConfig.findUnique({
				where: { guildId },
			});

			if (!config?.clanDirectoryChannelId || !config.clanDirectoryMessageId) {
				this.container.logger.error(`${header}Config suddenly missing for guild ${guildId}. Skipping.`); // Should not happen
				continue;
			}

			const channel = (await guild.channels
				.fetch(config.clanDirectoryChannelId)
				.catch(() => null)) as GuildTextBasedChannel | null;

			if (!channel || !channel.isTextBased()) {
				this.container.logger.warn(
					`${header}Skipping guild ${guild.name} (${guildId}): Directory channel ${config.clanDirectoryChannelId} not found or invalid.`,
				);
				continue;
			}

			let message: Message | null = null;
			try {
				message = await channel.messages.fetch(config.clanDirectoryMessageId);
			} catch {
				this.container.logger.warn(
					`${header}Directory message ${config.clanDirectoryMessageId} not found in channel ${config.clanDirectoryChannelId} for guild ${guild.name} (${guildId}). Attempting to recreate.`,
				);
				try {
					// Send a new message if the old one is gone
					message = await channel.send({ embeds: [createInfoEmbed('Clan Directory is initializing...')] });
					// Update the config with the NEW message ID
					await this.container.prisma.premiumGuildRoleConfig.update({
						where: { guildId },
						data: { clanDirectoryMessageId: message.id },
					});
					this.container.logger.info(
						`${header}Recreated directory message with new ID: ${message.id} for guild ${guild.name} (${guildId})`,
					);
				} catch (error) {
					this.container.logger.error(
						`${header}Failed to recreate directory message for guild ${guild.name} (${guildId})`,
						error,
					);
					continue;
				}
			}

			const allClansData: ClanDirectoryData[] = [];
			if (clans.length > 0) {
				for (const clan of clans) {
					const clanRole = (await guild.roles.fetch(clan.customRoleId).catch(() => null)) as Role | null;
					if (!clanRole) {
						this.container.logger.warn(
							`${header}Clan role ${clan.customRoleId} not found for clan in guild ${guild.name} (${guildId}). Skipping this clan entry.`,
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
						customRoleId: clan.customRoleId,
					});
				}
				this.container.logger.info(
					`${header}Prepared data for ${allClansData.length} visible clans in guild ${guildId}.`,
				);
				// Sort clans by member count
				allClansData.sort((a, b) => (BigInt(a.customRoleId) < BigInt(b.customRoleId) ? -1 : 1));
			}

			const clanEntries = allClansData.map((data, index) => this.formatClanEntry(data, index + 1));
			const embeds: EmbedBuilder[] = [];
			const baseEmbed = createInfoEmbed(null).setTitle(`✨ ${guild.name} Clan Directory ✨`);

			if (clanEntries.length === 0) {
				this.container.logger.info(`${header}Guild ${guildId} has 0 visible clans. Preparing empty embed.`);
				embeds.push(
					EmbedBuilder.from(baseEmbed)
						.setDescription('There are currently no visible clans to display.')
						.setFooter({ text: `Page 1 of 1 | Total Visible Clans: 0` }),
				);
			} else {
				for (let i = 0; i < clanEntries.length; i += clansPerPage) {
					const chunk = clanEntries.slice(i, i + clansPerPage);
					embeds.push(
						EmbedBuilder.from(baseEmbed)
							.setDescription(chunk.join('\n\n'))
							.setFooter({
								text: `Page ${Math.floor(i / clansPerPage) + 1} of ${Math.ceil(clanEntries.length / clansPerPage)} | Total Visible Clans: ${allClansData.length}`,
							}),
					);
				}
			}

			try {
				this.container.logger.info(
					`${header}Attempting to edit message ${message.id} in channel ${channel.id} for guild ${guildId}. Embed count: ${embeds.length}`,
				);
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

	private formatClanEntry(data: ClanDirectoryData, index: number): string {
		const rank = ''; // Placeholder for future points/rank system
		const ownerMention = data.ownerId ? `<@${data.ownerId}>` : '`Unknown Owner`';

		// Using block quotes for description
		const description = data.description
			.split('\n')
			.map((line) => `> ${line.trim()}`)
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
	customRoleId: string;
}
