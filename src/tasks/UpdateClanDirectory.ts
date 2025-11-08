import type { GuildTextBasedChannel, Message, Role } from 'discord.js';
import { EmbedBuilder } from 'discord.js';
import { MAX_MEMBERS_IN_CLAN } from '../lib/abilities/ClanManager.js';
import { Task } from '../lib/schedule/tasks/Task.js';
import { createInfoEmbed } from '../lib/utils/createEmbed.js';

const header = '[CLAN DIRECTORY] ';
const clansPerPage = 10;

// Emojis and icons
const CONNECTION1 = '<:ConnectionContinuing:1436843068438351944>';
const CONNECTION2 = '<:ConnectionEnding:1436843084985143449>';
const SEPARATOR = '<:valBlank:806719192191336448>';

export class UpdateClanDirectory extends Task {
	public async run() {
		this.container.logger.info(`${header}Starting clan directory update...`);

		const visibleClans = await this.container.prisma.clan.findMany({
			where: { isVisibleInDirectory: true },
			include: { members: true },
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
			this.container.logger.info(`${header}Processing guild ${guildId}. Found ${clans.length} clans.`);

			const guild = this.container.client.guilds.cache.get(guildId);
			if (!guild) {
				this.container.logger.warn(`${header}Skipping guild ${guildId}: not in cache.`);
				continue;
			}

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
					message = await channel.send({ embeds: [createInfoEmbed('Clan Directory is initializing...')] });
					await this.container.prisma.premiumGuildRoleConfig.update({
						where: { guildId },
						data: { clanDirectoryMessageId: message.id },
					});
				} catch (error) {
					this.container.logger.error(`${header}Failed to recreate message for ${guild.name}`, error);
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
				});
			}

			allClansData.sort((a, b) => a.name.localeCompare(b.name));

			const embeds: EmbedBuilder[] = [];

			for (let i = 0; i < allClansData.length; i += clansPerPage) {
				const chunk = allClansData.slice(i, i + clansPerPage);
				const embed = new EmbedBuilder()
					.setColor(0x27272f)
					.setDescription(`## ${guild.name} Clan Discovery\n${SEPARATOR}`)
					.setThumbnail(guild.iconURL({ extension: 'png', size: 128 }) ?? null);

				const fields: any[] = [];

				for (const data of chunk) {
					const clanRole = guild.roles.cache.get(data.customRoleId);
					const roleIcon =
						clanRole?.icon ?
							`<:roleicon:> [ ](https://cdn.discordapp.com/role-icons/${data.customRoleId}/${clanRole.icon}.webp)`
						:	`<:icon_Titan:1181684178467696680>`;

					const ownerMention = data.ownerId ? `<@${data.ownerId}>` : '`Unknown Owner`';
					const descriptionText = data.description || '*No description set*';

					fields.push({
						name: `${roleIcon}  ${data.name}`,
						value: [
							`-# ${CONNECTION1} Owner: ${ownerMention}`,
							`-# ${CONNECTION1} Members: \`${data.memberCount}\` / ${MAX_MEMBERS_IN_CLAN}`,
							`-# ${CONNECTION2} Description: ${descriptionText}`,
						].join('\n'),
						inline: false,
					});

					fields.push({
						name: ' ',
						value: SEPARATOR,
						inline: false,
					});
				}

				fields.push({
					name: ' ',
					value: `-# Last updated <t:${Math.floor(Date.now() / 1000)}:R>`,
					inline: false,
				});

				embed.setFields(fields);
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
				await message.edit({
					//content: `*Last updated: <t:${Math.floor(Date.now() / 1000)}:R>*`,
					embeds: [embeds[0]],
					components: [],
				});
				this.container.logger.info(`${header}Updated clan directory for ${guild.name}.`);
			} catch (error) {
				this.container.logger.error(`${header}Failed to edit clan directory for ${guild.name}`, error);
			}
		}

		this.container.logger.info(`${header}Finished clan directory update task.`);
		return null;
	}
}

interface ClanDirectoryData {
	name: string;
	description: string;
	memberCount: number;
	ownerId?: string | null;
	customRoleId: string;
}
