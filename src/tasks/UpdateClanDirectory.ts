import type { GuildTextBasedChannel, Message, Role } from 'discord.js';
import { EmbedBuilder } from 'discord.js';
import { get } from 'https';
import { Routes, type RESTGetAPIApplicationEmojisResult } from 'discord-api-types/v10';
import { MAX_MEMBERS_IN_CLAN } from '../lib/abilities/ClanManager.js';
import { Task } from '../lib/schedule/tasks/Task.js';
import { createInfoEmbed } from '../lib/utils/createEmbed.js';

const header = '[CLAN DIRECTORY] ';
const MAX_EMBEDS_PER_MESSAGE = 10;
const MAX_FIELDS_PER_EMBED = 25;
const MAX_MESSAGE_CHARACTERS = 6000; // Discord limit for all embeds in one message
const EMBED_SAFE_LIMIT = 5500; // Buffer to leave room for headers, footers, and overhead

// Emojis and icons
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

			allClansData.sort((a, b) => (BigInt(a.customRoleId) < BigInt(b.customRoleId) ? -1 : 1));

			const emojiMap = await this.syncRoleIconsAsAppEmojis(allClansData);
			const embeds: EmbedBuilder[] = [];

			let currentEmbed = new EmbedBuilder().setColor(0x27272f);
			let fieldCount = 0;

			// Initialize first embed with heading and thumbnail
			currentEmbed
				.setDescription(`## ${guild.name} Clan Directory\n${SEPARATOR}`)
				.setThumbnail(guild.iconURL({ extension: 'png', size: 128 }) ?? null);

			for (const data of allClansData) {
				const emoji = emojiMap.get(data.customRoleId);
				const roleIcon = emoji ? `<:${emoji.name}:${emoji.id}>` : FALLBACK_ICON;
				const ownerMention = data.ownerId ? `<@${data.ownerId}>` : '`Unknown Owner`';
				const descriptionText = data.description || '*No description set*';

				const clanField = {
					name: `${roleIcon}  ${data.name}`,
					value: [
						`-# ${CONNECTION1} Owner: ${ownerMention}`,
						`-# ${CONNECTION1} Members: \`${data.memberCount}\` / ${MAX_MEMBERS_IN_CLAN}`,
						`-# ${CONNECTION2} Description: ${descriptionText}`,
					].join('\n'),
					inline: false,
				};
				const separatorField = { name: ' ', value: SEPARATOR, inline: false };

				// Pre-calculate length of the new fields to prevent overflow
				const addedLength = clanField.name.length + clanField.value.length + separatorField.name.length + separatorField.value.length;

				// Create new embed if field limit or character limit is exceeded
				if ((fieldCount + 2 > MAX_FIELDS_PER_EMBED || this.getEmbedLength(currentEmbed) + addedLength > EMBED_SAFE_LIMIT) && fieldCount > 0) {
					embeds.push(currentEmbed);
					currentEmbed = new EmbedBuilder().setColor(0x27272f);
					fieldCount = 0;
				}

				currentEmbed.addFields(clanField, separatorField);
				fieldCount += 2;
			}

			const footerField = {
				name: ' ',
				value: `-# Request to join a clan with \`/clan join\`. \n-# Want to create a clan? Check out our [**server subscriptions!**](https://discord.com/channels/679875946597056683/shop) (desktop only)`,
				inline: false,
			};

			// Finalize the last embed with the footer
			if (fieldCount > 0) {
				if (this.getEmbedLength(currentEmbed) + footerField.name.length + footerField.value.length > MAX_MESSAGE_CHARACTERS) {
					embeds.push(currentEmbed);
					currentEmbed = new EmbedBuilder().setColor(0x27272f);
				}
				currentEmbed.addFields(footerField);
				embeds.push(currentEmbed);
			}

			if (embeds.length === 0) {
				embeds.push(
					new EmbedBuilder()
						.setColor(0x27272f)
						.setDescription(`## ${guild.name} Clan Directory\n${SEPARATOR}`)
						.setThumbnail(guild.iconURL({ extension: 'png', size: 128 }) ?? null)
						.addFields(footerField),
				);
			}

			try {
				// Chunk embeds by count (10) AND total character count (6000)
				const chunks: EmbedBuilder[][] = [];
				let currentChunk: EmbedBuilder[] = [];
				let currentChunkLength = 0;

				for (const embed of embeds) {
					const embedLength = this.getEmbedLength(embed);
					if (currentChunk.length >= MAX_EMBEDS_PER_MESSAGE || currentChunkLength + embedLength > MAX_MESSAGE_CHARACTERS) {
						chunks.push(currentChunk);
						currentChunk = [embed];
						currentChunkLength = embedLength;
					} else {
						currentChunk.push(embed);
						currentChunkLength += embedLength;
					}
				}
				if (currentChunk.length > 0) chunks.push(currentChunk);

				await message.edit({ embeds: chunks[0], components: [] });

				const existingMessages = await channel.messages.fetch({ limit: 100 });
				const oldDirectoryMessages = existingMessages.filter(
					(m) => m.author.id === this.container.client.user?.id && m.id !== message.id,
				);

				for (const old of oldDirectoryMessages.values()) {
					try {
						await old.delete();
					} catch (err) {
						this.container.logger.warn(`${header}Failed to delete old directory message`, err);
					}
				}

				for (let i = 1; i < chunks.length; i++) {
					try {
						await channel.send({ embeds: chunks[i] });
					} catch (err) {
						this.container.logger.error(`${header}Failed to send directory chunk ${i}`, err);
					}
				}

				this.container.logger.info(
					`${header}Updated clan directory for ${guild.name} (${embeds.length} embeds across ${chunks.length} messages).`,
				);
			} catch (error) {
				this.container.logger.error(
					`${header}Failed to edit clan directory for ${guild.name}`,
					error instanceof Error ? error.message : error,
				);
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

	private async syncRoleIconsAsAppEmojis(clans: ClanDirectoryData[]): Promise<Map<string, { id: string; name: string }>> {
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

		const storedIconHashes = await this.container.prisma.clanEmojiCache.findMany();
		const storedMap = new Map(storedIconHashes.map((entry) => [entry.roleId, entry.iconHash]));

		for (const clan of clans) {
			const emojiName = `role_${clan.customRoleId}`;
			const existingEmoji = existing.find((e) => e.name === emojiName);
			const storedIconHash = storedMap.get(clan.customRoleId);
			const iconChanged = storedIconHash !== clan.iconHash;

			if (!clan.iconHash) {
				emojiMap.set(clan.customRoleId, existingEmoji ? { id: existingEmoji.id, name: emojiName } : null!);
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

				let createdEmoji: { id: string; name: string };

				if (existingEmoji && iconChanged) {
					try {
						await rest.delete(Routes.applicationEmoji(APPLICATION_ID, existingEmoji.id));
						this.container.logger.info(`[ICON SYNC] Deleted old emoji for clan ${clan.name}`);
					} catch (err) {
						this.container.logger.warn(`[ICON SYNC] Failed to delete old emoji for clan ${clan.name}:`, err);
					}
				}

				createdEmoji = (await rest.post(Routes.applicationEmojis(APPLICATION_ID), {
					body: { name: emojiName, image: base64 },
				})) as { id: string; name: string };

				this.container.logger.info(`[ICON SYNC] ${iconChanged ? 'Updated' : 'Uploaded'} application emoji for ${clan.name}`);

				await this.container.prisma.clanEmojiCache.upsert({
					where: { roleId: clan.customRoleId },
					create: { roleId: clan.customRoleId, iconHash: clan.iconHash },
					update: { iconHash: clan.iconHash },
				});

				emojiMap.set(clan.customRoleId, createdEmoji);
			} catch (err) {
				this.container.logger.error(`[ICON SYNC] Failed to sync emoji for clan ${clan.name}:`, err);
				if (existingEmoji) {
					emojiMap.set(clan.customRoleId, { id: existingEmoji.id, name: emojiName });
				}
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