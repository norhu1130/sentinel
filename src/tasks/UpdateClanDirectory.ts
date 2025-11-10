import type {
	GuildTextBasedChannel,
	Message,
	Role,
} from 'discord.js';
import { EmbedBuilder } from 'discord.js';
import { get } from 'https';
import { Routes } from 'discord-api-types/v10';
import { MAX_MEMBERS_IN_CLAN } from '../lib/abilities/ClanManager.js';
import { Task } from '../lib/schedule/tasks/Task.js';
import { createInfoEmbed } from '../lib/utils/createEmbed.js';

const header = '[CLAN DIRECTORY] ';
const clansPerPage = 10;

// Emojis and icons
const CONNECTION1 = '<:ConnectionContinuing:1436843068438351944>';
const CONNECTION2 = '<:ConnectionEnding:1436843084985143449>';
const SEPARATOR = '<:valBlank:806719192191336448>';
const FALLBACK_ICON = '<:icon_Titan:1181684178467696680>'; // Titan fallback emoji

// Application ID for emoji uploads
const APPLICATION_ID = "1107437965233369118";

export class UpdateClanDirectory extends Task {
	public async run() {
		this.container.logger.info(`${header}Starting clan directory update...`);

		const visibleClans = await this.container.prisma.clan.findMany({
			where: { isVisibleInDirectory: true },
			include: { members: true },
		});
		this.container.logger.info(`${header}Fetched ${visibleClans.length} visible clans.`);

		const clansByGuild = visibleClans.reduce((map, clan) => {
			const list = map.get(clan.guildId) ?? [];
			list.push(clan);
			map.set(clan.guildId, list);
			return map;
		}, new Map<string, typeof visibleClans>());

		const configuredGuilds = await this.container.prisma.premiumGuildRoleConfig.findMany({
			where: { clanDirectoryChannelId: { not: null }, clanDirectoryMessageId: { not: null } },
			select: { guildId: true },
		});

		for (const { guildId } of configuredGuilds) {
			const clans = clansByGuild.get(guildId) ?? [];
			const guild = this.container.client.guilds.cache.get(guildId);
			if (!guild) continue;

			this.container.logger.info(`${header}Processing guild ${guild.name} (${clans.length} clans).`);

			const config = await this.container.prisma.premiumGuildRoleConfig.findUnique({
				where: { guildId },
			});
			if (!config?.clanDirectoryChannelId || !config.clanDirectoryMessageId) continue;

			const channel = (await guild.channels
				.fetch(config.clanDirectoryChannelId)
				.catch(() => null)) as GuildTextBasedChannel | null;

			if (!channel || !channel.isTextBased()) continue;

			let message: Message | null = null;
			try {
				message = await channel.messages.fetch(config.clanDirectoryMessageId);
			} catch {
				try {
					message = await channel.send({
						embeds: [createInfoEmbed('Clan Directory is initializing...')],
					});
					await this.container.prisma.premiumGuildRoleConfig.update({
						where: { guildId },
						data: { clanDirectoryMessageId: message.id },
					});
				} catch (err) {
					this.container.logger.error(`${header}Failed to recreate message for ${guild.name}`, err);
					continue;
				}
			}

			const allClansData: ClanDirectoryData[] = [];
			for (const clan of clans) {
				const clanRole = (await guild.roles.fetch(clan.customRoleId).catch(() => null)) as Role | null;
				if (!clanRole) continue;

				const premiumMember = await this.container.prisma.premiumMember.findFirst({
					where: { guildId: clan.guildId, customRoleId: clan.customRoleId },
				});

				allClansData.push({
					name: clanRole.name,
					description: clan.description ?? '*No description set*',
					memberCount: clan.members.length,
					ownerId: premiumMember?.userId,
					customRoleId: clan.customRoleId,
					iconHash: clanRole.icon,
				});
			}

			allClansData.sort((a, b) => a.name.localeCompare(b.name));

			const emojiMap = await this.syncRoleIconsAsAppEmojis(allClansData);
			const embeds: EmbedBuilder[] = [];

			for (let i = 0; i < allClansData.length; i += clansPerPage) {
				const chunk = allClansData.slice(i, i + clansPerPage);
				const embed = new EmbedBuilder()
					.setColor(0x27272f)
					.setDescription(`## ${guild.name} Clan Discovery\n${SEPARATOR}`)
					.setThumbnail(guild.iconURL({ extension: 'png', size: 128 }) ?? null);

				const fields: any[] = [];

				for (const data of chunk) {
					const emoji = emojiMap.get(data.customRoleId);
					const roleIcon = emoji ? `<:${emoji.name}:${emoji.id}>` : FALLBACK_ICON;

					const ownerMention = data.ownerId ? `<@${data.ownerId}>` : '`Unknown Owner`';
					const descriptionText = data.description || '*No description set*';

					fields.push({
						name: `${roleIcon} ${data.name}`,
						value: [
							`-# ${CONNECTION1} Owner: ${ownerMention}`,
							`-# ${CONNECTION1} Members: \`${data.memberCount}\` / ${MAX_MEMBERS_IN_CLAN}`,
							`-# ${CONNECTION2} Description: ${descriptionText}`,
						].join('\n'),
						inline: false,
					});

					fields.push({ name: ' ', value: SEPARATOR, inline: false });
				}

				fields.push({
					name: ' ',
					value: `-# Last updated <t:${Math.floor(Date.now() / 1000)}:R>`,
					inline: false,
				});

				embed.setFields(fields);
				embed.setFooter({
					text: `Page ${Math.floor(i / clansPerPage) + 1} of ${Math.ceil(
						allClansData.length / clansPerPage,
					)} | Total Visible Clans: ${allClansData.length}`,
				});

				embeds.push(embed);
			}

			if (embeds.length === 0) {
				embeds.push(
					new EmbedBuilder()
						.setColor(0x27272f)
						.setDescription(`## ${guild.name} Clan Discovery\n${SEPARATOR}`)
						.setThumbnail(guild.iconURL({ extension: 'png', size: 128 }) ?? null)
						.setFooter({ text: 'Page 1 of 1 | Total Visible Clans: 0' }),
				);
			}

			try {
				await message.edit({ embeds: [embeds[0]], components: [] });
				this.container.logger.info(`${header}Updated clan directory for ${guild.name}.`);
			} catch (error) {
				this.container.logger.error(`${header}Failed to edit clan directory for ${guild.name}`, error);
			}
		}

		this.container.logger.info(`${header}Finished clan directory update.`);
		return null;
	}

	/**
	 * Uploads role icons as application emojis (to the bot's 2000-slot emoji pool).
	 */
	private async syncRoleIconsAsAppEmojis(
		clans: ClanDirectoryData[],
	): Promise<Map<string, { id: string; name: string }>> {
		const rest = this.container.client.rest;
		const emojiMap = new Map<string, { id: string; name: string }>();

		// download helper
		const downloadBuffer = (url: string): Promise<Buffer> =>
			new Promise((resolve, reject) => {
				get(url, (res) => {
					if (res.statusCode !== 200) {
						reject(new Error(`HTTP ${res.statusCode}`));
						return;
					}
					const data: Buffer[] = [];
					res.on('data', (chunk: Buffer) => data.push(chunk));
					res.on('end', () => resolve(Buffer.concat(data)));
				}).on('error', reject);
			});

		let existing: any[] = [];
		try {
			existing = (await rest.get(Routes.applicationEmojis(APPLICATION_ID))) as any[];
		} catch (err) {
			this.container.logger.error('[ICON SYNC] Failed to fetch existing application emojis:', err);
		}

		for (const clan of clans) {
			if (!clan.iconHash) continue;

			const emojiName = `role_${clan.customRoleId}`;
			const existingEmoji = existing.find((e) => e.name === emojiName);
			if (existingEmoji) {
				emojiMap.set(clan.customRoleId, { id: existingEmoji.id, name: emojiName });
				continue;
			}

			const iconURL = `https://cdn.discordapp.com/role-icons/${clan.customRoleId}/${clan.iconHash}.webp`;

			try {
				const buffer = await downloadBuffer(iconURL);
				const base64 = `data:image/png;base64,${buffer.toString('base64')}`;

				const created = (await rest.post(Routes.applicationEmojis(APPLICATION_ID), {
					body: { name: emojiName, image: base64 },
				})) as { id: string; name: string };

				this.container.logger.info(`[ICON SYNC] Uploaded application emoji for ${clan.name}`);
				emojiMap.set(clan.customRoleId, created);
			} catch (err) {
				this.container.logger.error(`[ICON SYNC] Failed to upload app emoji for ${clan.name}:`, err);
			}
		}

		return emojiMap;
	}
}

interface ClanDirectoryData {
	name: string;
	description: string;
	memberCount: number;
	ownerId?: string | null;
	customRoleId: string;
	iconHash?: string | null;
}
