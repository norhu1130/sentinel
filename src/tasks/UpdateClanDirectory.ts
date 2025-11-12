import type { GuildTextBasedChannel, Message, Role } from 'discord.js';
import { EmbedBuilder } from 'discord.js';
import { get } from 'https';
import { Routes, type RESTGetAPIApplicationEmojisResult } from 'discord-api-types/v10';
import { MAX_MEMBERS_IN_CLAN } from '../lib/abilities/ClanManager.js';
import { Task } from '../lib/schedule/tasks/Task.js';
import { createInfoEmbed } from '../lib/utils/createEmbed.js';

const header = '[CLAN DIRECTORY] ';


const clansPerPage = 10;

// Emojis and icons
const CONNECTION1 = '<:ConnectionContinuing:1436843068438351944>';
const CONNECTION2 = '<:ConnectionEnding:1436843084985143449>';
const SEPARATOR = '<:valBlank:806719192191336448>';
const FALLBACK_ICON = '<:icon_Titan:1181684178467696680>';

export class UpdateClanDirectory extends Task {
	public async run() {
		this.container.logger.info(`${header}Starting clan directory update (TEST MODE: 1 per embed)...`);

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

			allClansData.sort((a, b) => Number(a.customRoleId) - Number(b.customRoleId));

			const emojiMap = await this.syncRoleIconsAsAppEmojis(allClansData);
			const embeds: EmbedBuilder[] = [];

			for (let i = 0; i < allClansData.length; i += clansPerPage) {
				const chunk = allClansData.slice(i, i + clansPerPage);
				const data = chunk[0];
				if (!data) continue;

				const emoji = emojiMap.get(data.customRoleId);
				const roleIcon = emoji ? `<:${emoji.name}:${emoji.id}>` : FALLBACK_ICON;
				const ownerMention = data.ownerId ? `<@${data.ownerId}>` : '`Unknown Owner`';
				const descriptionText = data.description || '*No description set*';

				const embed = new EmbedBuilder().setColor(0x27272f);

				// Add header & thumbnail only to first embed
				if (i === 0) {
					embed
						.setDescription(`## ${guild.name} Clan Discovery\n${SEPARATOR}`)
						.setThumbnail(guild.iconURL({ extension: 'png', size: 128 }) ?? null);
				}

				embed.addFields({
					name: `${roleIcon}  ${data.name}`,
					value: [
						`-# ${CONNECTION1} Owner: ${ownerMention}`,
						`-# ${CONNECTION1} Members: \`${data.memberCount}\` / ${MAX_MEMBERS_IN_CLAN}`,
						`-# ${CONNECTION2} Description: ${descriptionText}`,
					].join('\n'),
					inline: false,
				});

				// Add footer only on the last embed
				if (i + clansPerPage >= allClansData.length) {
					embed.addFields({
						name: ' ',
						value: `-# Last updated <t:${Math.floor(Date.now() / 1000)}:R>`,
						inline: false,
					});
				}

				embeds.push(embed);
			}

			if (embeds.length === 0) {
				embeds.push(
					new EmbedBuilder()
						.setColor(0x27272f)
						.setDescription(`## ${guild.name} Clan Discovery\n${SEPARATOR}`)
						.setThumbnail(guild.iconURL({ extension: 'png', size: 128 }) ?? null),
				);
			}

			try {
				const MAX_EMBEDS_PER_MESSAGE = 10;

				if (embeds.length <= MAX_EMBEDS_PER_MESSAGE) {
					await message.edit({ embeds, components: [] });
				} else {
					const chunks: EmbedBuilder[][] = [];
					for (let i = 0; i < embeds.length; i += MAX_EMBEDS_PER_MESSAGE) {
						chunks.push(embeds.slice(i, i + MAX_EMBEDS_PER_MESSAGE));
					}

					await message.edit({ embeds: chunks[0], components: [] });

					const existingMessages = await channel.messages.fetch({ limit: 20 });
					const oldDirectoryMessages = existingMessages.filter(
						(m) => m.author.id === this.container.client.user?.id && m.id !== message.id,
					);

					for (const old of oldDirectoryMessages.values()) {
						await old.delete().catch(() => null);
					}

					for (let i = 1; i < chunks.length; i++) {
						await channel.send({ embeds: chunks[i] });
					}
				}

				this.container.logger.info(`${header}Updated clan directory for ${guild.name} (${embeds.length} embeds).`);
			} catch (error) {
				this.container.logger.error(`${header}Failed to edit clan directory for ${guild.name}`, error);
			}
		}

		this.container.logger.info(`${header}Finished clan directory update.`);
		return null;
	}

	private async syncRoleIconsAsAppEmojis(
		clans: ClanDirectoryData[],
	): Promise<Map<string, { id: string; name: string }>> {
		const APPLICATION_ID = this.container.client.application!.id;
		const rest = this.container.client.rest;
		const emojiMap = new Map<string, { id: string; name: string }>();

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
			const response = (await rest.get(
				Routes.applicationEmojis(APPLICATION_ID),
			)) as RESTGetAPIApplicationEmojisResult;

			if (response && Array.isArray(response.items)) {
				existing = response.items;
			} else {
				this.container.logger.warn(
					'[ICON SYNC] Unexpected response format from applicationEmojis API',
					response,
				);
				existing = [];
			}
		} catch (err) {
			this.container.logger.error('[ICON SYNC] Failed to fetch existing application emojis:', err);
			existing = [];
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
