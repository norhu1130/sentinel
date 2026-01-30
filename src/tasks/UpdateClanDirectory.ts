import { Buffer } from 'node:buffer';
import { get } from 'node:https';
import { Routes, type RESTGetAPIApplicationEmojisResult } from 'discord-api-types/v10';
import type { GuildTextBasedChannel, Message, Role } from 'discord.js';
import { EmbedBuilder } from 'discord.js';
import { MAX_MEMBERS_IN_CLAN } from '../lib/abilities/ClanManager.js';
import { Task } from '../lib/schedule/tasks/Task.js';

const header = '[CLAN DIRECTORY] ';

const MAX_EMBEDS_PER_MESSAGE = 10;
const MAX_FIELDS_PER_EMBED = 25;
const MAX_MESSAGE_CHARACTERS = 6_000;
const EMBED_SAFE_LIMIT = 5_500;

const CONNECTION1 = '<:ConnectionContinuing:1436843068438351944>';
const CONNECTION2 = '<:ConnectionEnding:1436843084985143449>';
const SEPARATOR = '<:valBlank:806719192191336448>';
const FALLBACK_ICON = '<:icon_Titan:1181684178467696680>';

export class UpdateClanDirectory extends Task {
	public async run() {
		this.container.logger.info(`${header}Starting clan directory update...`);

		const visibleClans = await this.container.prisma.clan.findMany({
			where: { isVisibleInDirectory: true },
			include: { members: true },
		});

		const clansByGuild = visibleClans.reduce((map, clan) => {
			const list = map.get(clan.guildId) ?? [];
			list.push(clan);
			map.set(clan.guildId, list);
			return map;
		}, new Map<string, typeof visibleClans>());

		const configuredGuilds = await this.container.prisma.premiumGuildRoleConfig.findMany({
			where: { clanDirectoryChannelId: { not: null } },
			select: { guildId: true },
		});

		for (const { guildId } of configuredGuilds) {
			const clans = clansByGuild.get(guildId) ?? [];
			const guild = this.container.client.guilds.cache.get(guildId);
			if (!guild) continue;

			const config = await this.container.prisma.premiumGuildRoleConfig.findUnique({
				where: { guildId },
			});
			if (!config?.clanDirectoryChannelId) continue;

			const channel = (await guild.channels
				.fetch(config.clanDirectoryChannelId)
				.catch(() => null)) as GuildTextBasedChannel | null;
			if (!channel?.isTextBased()) continue;

			// 1. Prepare Clan Data
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

			allClansData.sort((a, b) => (BigInt(a.customRoleId) < BigInt(b.customRoleId) ? -1 : 1));
			const emojiMap = await this.syncRoleIconsAsAppEmojis(allClansData);

			// 2. Build Embeds with character limit awareness
			const embeds: EmbedBuilder[] = [];
			let currentEmbed = new EmbedBuilder().setColor(0x27272f);
			let fieldCount = 0;

			currentEmbed
				.setDescription(`## ${guild.name} Clan Directory\n${SEPARATOR}`)
				.setThumbnail(guild.iconURL({ extension: 'png', size: 128 }) ?? null);

			for (const data of allClansData) {
				const emoji = emojiMap.get(data.customRoleId);
				const roleIcon = emoji ? `<:${emoji.name}:${emoji.id}>` : FALLBACK_ICON;
				const ownerMention = data.ownerId ? `<@${data.ownerId}>` : '`Unknown Owner`';
				const descriptionText = data.description || '*No description set*';

				const clanField = {
					name: ` `,
					value: [
						`${roleIcon} <@&${data.customRoleId}>`,
						`-# ${CONNECTION1} Owner: ${ownerMention}`,
						`-# ${CONNECTION1} Members: \`${data.memberCount}\` / ${MAX_MEMBERS_IN_CLAN}`,
						`-# ${CONNECTION2} Description: ${descriptionText}`,
					].join('\n'),
					inline: false,
				};
				const separatorField = { name: ' ', value: SEPARATOR, inline: false };
				const addedLength =
					clanField.name.length +
					clanField.value.length +
					separatorField.name.length +
					separatorField.value.length;

				if (
					(fieldCount + 2 > MAX_FIELDS_PER_EMBED ||
						this.getEmbedLength(currentEmbed) + addedLength > EMBED_SAFE_LIMIT) &&
					fieldCount > 0
				) {
					embeds.push(currentEmbed);
					currentEmbed = new EmbedBuilder().setColor(0x27272f);
					fieldCount = 0;
				}

				currentEmbed.addFields(clanField, separatorField);
				fieldCount += 2;
			}

			const footerField = {
				name: ' ',
				value: `-# Request to join a clan with \`/clan join\`. \n-# Want to create a clan? Check out our [**server subscriptions! **](https://discord.com/channels/679875946597056683/shop)(desktop only)`,
				inline: false,
			};

			if (
				this.getEmbedLength(currentEmbed) + footerField.name.length + footerField.value.length >
				EMBED_SAFE_LIMIT
			) {
				embeds.push(currentEmbed);
				currentEmbed = new EmbedBuilder().setColor(0x27272f);
			}

			currentEmbed.addFields(footerField);
			embeds.push(currentEmbed);

			// 3. Chunk Embeds into Messages
			const chunks: EmbedBuilder[][] = [];
			let currentChunk: EmbedBuilder[] = [];
			let currentChunkLen = 0;

			for (const embed of embeds) {
				const len = this.getEmbedLength(embed);
				if (currentChunk.length >= MAX_EMBEDS_PER_MESSAGE || currentChunkLen + len > MAX_MESSAGE_CHARACTERS) {
					chunks.push(currentChunk);
					currentChunk = [embed];
					currentChunkLen = len;
				} else {
					currentChunk.push(embed);
					currentChunkLen += len;
				}
			}

			if (currentChunk.length > 0) chunks.push(currentChunk);

			// 4. Update Messages (Edit if exists, Send if new)
			const oldMessageIds = config.clanDirectoryMessageIds || [];
			const newMessageIds: string[] = [];

			try {
				for (const [idx, chunk] of chunks.entries()) {
					let message: Message | null = null;
					if (oldMessageIds[idx]) {
						message = await channel.messages.fetch(oldMessageIds[idx]).catch(() => null);
					}

					if (message) {
						await message.edit({ embeds: chunk, components: [] });
						newMessageIds.push(message.id);
					} else {
						const sent = await channel.send({ embeds: chunk });
						newMessageIds.push(sent.id);
					}
				}

				// Delete leftover messages if directory shrank
				if (oldMessageIds.length > chunks.length) {
					const extraIds = oldMessageIds.slice(chunks.length);
					for (const id of extraIds) {
						const msg = await channel.messages.fetch(id).catch(() => null);
						if (msg) await msg.delete().catch(() => null);
					}
				}

				// Sync Database
				await this.container.prisma.premiumGuildRoleConfig.update({
					where: { guildId },
					data: { clanDirectoryMessageIds: newMessageIds },
				});
			} catch (error) {
				this.container.logger.error(`${header}Error updating directory for ${guild.name}:`, error);
			}
		}

		this.container.logger.info(`${header}Finished clan directory update.`);
		return null;
	}

	private getEmbedLength(embed: EmbedBuilder): number {
		const data = embed.data;
		let length = 0;
		length += data.title?.length ?? 0;
		length += data.description?.length ?? 0;
		length += data.footer?.text?.length ?? 0;
		length += data.author?.name?.length ?? 0;
		for (const field of data.fields ?? []) {
			length += field.name.length;
			length += field.value.length;
		}

		return length;
	}

	private async syncRoleIconsAsAppEmojis(
		clans: ClanDirectoryData[],
	): Promise<Map<string, { id: string; name: string }>> {
		const APPLICATION_ID = this.container.client.application!.id;
		const rest = this.container.client.rest;
		const emojiMap = new Map<string, { id: string; name: string }>();

		const downloadBuffer = async (url: string): Promise<Buffer> =>
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
			existing = response?.items || [];
		} catch (error) {
			this.container.logger.error('[ICON SYNC] Failed to fetch existing application emojis:', error);
		}

		const storedIconHashes = await this.container.prisma.clanEmojiCache.findMany();
		const storedMap = new Map(storedIconHashes.map((entry) => [entry.roleId, entry.iconHash]));

		for (const clan of clans) {
			const emojiName = `role_${clan.customRoleId}`;
			const existingEmoji = existing.find((em) => em.name === emojiName);
			const storedIconHash = storedMap.get(clan.customRoleId);
			const iconChanged = storedIconHash !== clan.iconHash;

			if (!clan.iconHash) {
				if (existingEmoji) emojiMap.set(clan.customRoleId, { id: existingEmoji.id, name: emojiName });
				continue;
			}

			if (existingEmoji && !iconChanged) {
				emojiMap.set(clan.customRoleId, { id: existingEmoji.id, name: emojiName });
				continue;
			}

			const iconURL = `https://cdn.discordapp.com/role-icons/${clan.customRoleId}/${clan.iconHash}.webp`;

			try {
				const buffer = await downloadBuffer(iconURL);
				const base64 = `data:image/png;base64,${buffer.toString('base64')}`;

				if (existingEmoji && iconChanged) {
					await rest.delete(Routes.applicationEmoji(APPLICATION_ID, existingEmoji.id)).catch(() => null);
				}

				const createdEmoji = (await rest.post(Routes.applicationEmojis(APPLICATION_ID), {
					body: { name: emojiName, image: base64 },
				})) as { id: string; name: string };

				await this.container.prisma.clanEmojiCache.upsert({
					where: { roleId: clan.customRoleId },
					create: { roleId: clan.customRoleId, iconHash: clan.iconHash },
					update: { iconHash: clan.iconHash },
				});

				emojiMap.set(clan.customRoleId, createdEmoji);
			} catch (error) {
				this.container.logger.error(`[ICON SYNC] Failed to sync emoji for clan ${clan.name}:`, error);
				if (existingEmoji) emojiMap.set(clan.customRoleId, { id: existingEmoji.id, name: emojiName });
			}
		}

		return emojiMap;
	}
}

interface ClanDirectoryData {
	customRoleId: string;
	description: string;
	iconHash?: string | null;
	memberCount: number;
	name: string;
	ownerId?: string | null;
}
