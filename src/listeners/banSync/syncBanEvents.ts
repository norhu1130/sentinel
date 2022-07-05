import { ApplyOptions } from '@sapphire/decorators';
import { container, Events, Listener } from '@sapphire/framework';
import { Time } from '@sapphire/time-utilities';
import { PermissionFlagsBits, RESTJSONErrorCodes } from 'discord-api-types/v10';
import { DiscordAPIError, GuildBan } from 'discord.js';
import { useGuildIdsToSyncBansIn } from '../../lib/utils/hooks/useGuildIdsToSyncBansIn.js';

const recentlySeenBanEvents = new Map<string, { userId: string; at: number }>();

setInterval(() => {
	for (const [userId, { at }] of recentlySeenBanEvents) {
		if (Date.now() - at > Time.Minute * 2) {
			recentlySeenBanEvents.delete(userId);
		}
	}
}).unref();

@ApplyOptions<Listener.Options>({
	event: Events.GuildBanAdd,
	name: 'BanAddChecker',
})
export class BanAddChecker extends Listener<typeof Events.GuildBanAdd> {
	public async run(ban: GuildBan) {
		const guildIdsToCheck = useGuildIdsToSyncBansIn();
		const { guild } = ban;

		if (!guildIdsToCheck.includes(guild.id)) {
			return;
		}

		if (recentlySeenBanEvents.has(ban.user.id)) {
			this.container.logger.debug(
				`Ignoring ban from ${ban.guild.name} (${ban.guild.id}) for ${ban.user.tag} (${ban.user.id}) because it was recently seen`,
			);
			return;
		}

		recentlySeenBanEvents.set(ban.user.id, { userId: ban.user.id, at: Date.now() });

		const fullBan = await ban.fetch(true);

		this.container.logger.info(
			`Received ban create for ${fullBan.user.tag} (${fullBan.user.id}) in ${fullBan.guild.name} (${
				fullBan.guild.id
			}) for: ${fullBan.reason ?? 'no reason'}. Syncing with the other guilds...`,
		);
		// Create DB entry for it
		await this.container.prisma.sharedGuildBan.upsert({
			create: {
				guild_id: ban.guild.id,
				user_id: ban.user.id,
				reason: fullBan.reason ?? null,
			},
			update: {
				reason: fullBan.reason ?? null,
				guild_id: ban.guild.id,
			},
			where: {
				user_id: ban.user.id,
			},
		});

		for await (const guild of getUsableGuilds()) {
			const maybeMember = await guild.members.fetch({ user: fullBan.user.id }).catch(() => null);

			if (maybeMember) {
				if (!maybeMember.bannable) {
					container.logger.warn(
						`  Can't ban user ${fullBan.user.tag} (${fullBan.user.id}) from guild ${guild.name} (${
							guild.id
						}) because they are above me (previously banned for: ${fullBan.reason ?? 'no reason'})`,
					);
					continue;
				}

				this.container.logger.info(
					`  Banning user ${fullBan.user.tag} (${fullBan.user.id}) in guild ${guild.name} (${guild.id})`,
				);

				await guild.bans.create(maybeMember.id, {
					days: 0,
					reason: `BAN SYNC(${fullBan.guild.name}): ${fullBan.reason ?? 'No reason'}`,
				});
			}
		}
	}
}

@ApplyOptions<Listener.Options>({
	event: Events.GuildBanRemove,
	name: 'BanRemoveChecker',
})
export class BanRemoveChecker extends Listener<typeof Events.GuildBanRemove> {
	public async run(ban: GuildBan) {
		const guildIdsToCheck = useGuildIdsToSyncBansIn();
		const { guild } = ban;

		if (!guildIdsToCheck.includes(guild.id)) {
			return;
		}

		if (recentlySeenBanEvents.has(ban.user.id)) {
			this.container.logger.debug(
				`Ignoring unban from ${ban.guild.name} (${ban.guild.id}) for ${ban.user.tag} (${ban.user.id}) because it was recently seen`,
			);
			return;
		}

		recentlySeenBanEvents.set(ban.user.id, { userId: ban.user.id, at: Date.now() });

		this.container.logger.info(
			`Received ban delete for ${ban.user.tag} (${ban.user.id}) in ${ban.guild.name} (${ban.guild.id}). Syncing with the other guilds...`,
		);

		await this.container.prisma.sharedGuildBan.delete({
			where: { user_id: ban.user.id },
		});

		for await (const guild of getUsableGuilds()) {
			try {
				await guild.bans.remove(ban.user.id, `BAN SYNC(${ban.guild.name}): Unbanned from server`);
				this.container.logger.info(
					`  Removed ban from user ${ban.user.tag} (${ban.user.id}) in guild ${guild.name} (${guild.id})`,
				);
			} catch (err) {
				if (err instanceof DiscordAPIError) {
					if (err.code === RESTJSONErrorCodes.UnknownBan) {
						continue;
					}

					this.container.logger.warn(
						`  Failed to remove ban from user ${ban.user.tag} (${ban.user.id}) in guild ${guild.name} (${guild.id})`,
						err,
					);
				}
			}
		}
	}
}

async function* getUsableGuilds() {
	const guildIds = useGuildIdsToSyncBansIn();

	for (const guildId of guildIds) {
		const guild = container.client.guilds.resolve(guildId);

		if (!guild) {
			container.logger.warn(`  Couldn't find guild ${guildId} to sync bans with!`);
			continue;
		}

		const me = await guild.members.fetch({ user: container.client.user!.id });
		if (!me.permissions.has(PermissionFlagsBits.BanMembers)) {
			container.logger.warn(
				`  Can't apply bans/unbans in guild ${guild.name} (${guildId}) because I don't have the Ban Members permission!`,
			);
			continue;
		}

		yield guild;
	}
}
