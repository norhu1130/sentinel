import type { SharedGuildBan } from '@prisma/client';
import { ApplyOptions } from '@sapphire/decorators';
import { Events, Listener } from '@sapphire/framework';
import { PermissionFlagsBits } from 'discord-api-types/v10';
import { useGuildIdsToSyncBansIn } from '../../lib/utils/hooks/useGuildIdsToSyncBansIn.js';

const header = '[BAN SYNC] ';

@ApplyOptions<Listener.Options>({
	event: Events.ClientReady,
})
export class LoadBansOnReady extends Listener {
	public async run() {
		const guildIds = useGuildIdsToSyncBansIn();

		const banList = new Map<string, SharedGuildBan>();

		this.container.logger.info(`${header}Fetching all bans for the provided guilds, this might take a while...`);

		// Fetch all bans from guilds
		for (const guildId of guildIds) {
			const guild = this.container.client.guilds.resolve(guildId);

			if (!guild) {
				this.container.logger.warn(`${header}  Couldn't find guild ${guildId} to sync bans with!`);
				continue;
			}

			const me = await guild.members.fetch({ user: this.container.client.user!.id });
			if (!me.permissions.has(PermissionFlagsBits.BanMembers, true)) {
				this.container.logger.warn(
					`${header}  Can't fetch bans from guild ${guild.name} (${guildId}) because I don't have the Ban Members permission!`,
				);
				continue;
			}

			let after = '0';

			while (true) {
				const banChunk = [
					...(
						await guild.bans.fetch({
							limit: 1000,
							after,
							cache: false,
						})
					).values(),
				].sort((a, b) => Number(BigInt(a.user.id) - BigInt(b.user.id)));

				// Edge case for no bans causing this to break -w-
				if (banChunk.length === 0) {
					break;
				}

				after = banChunk.at(-1)!.user.id;

				for (const ban of banChunk) {
					if (!banList.has(ban.user.id)) {
						banList.set(ban.user.id, {
							guild_id: guildId,
							reason: ban.reason ?? null,
							user_id: ban.user.id,
						});
					}
				}

				if (banChunk.length < 1000) {
					this.container.logger.info(`${header}  Fetched all bans for guild ${guild.name} (${guild.id})`);
					break;
				}
			}
		}

		// Clear the database
		await this.container.prisma.sharedGuildBan.deleteMany();

		// Insert all bans
		this.container.logger.info(`${header}Saving ${banList.size} bans to the database`);

		for (const ban of banList.values()) {
			await this.container.prisma.sharedGuildBan.create({
				data: ban,
			});
		}

		this.container.logger.info(`${header}Saved bans to the database. Now checking if any bans have not been synced...`);

		for (const guildId of guildIds) {
			const guild = this.container.client.guilds.resolve(guildId);

			if (!guild) {
				this.container.logger.warn(`${header}  Couldn't find guild ${guildId} to sync bans with!`);
				continue;
			}

			const me = await guild.members.fetch({ user: this.container.client.user!.id });
			if (!me.permissions.has(PermissionFlagsBits.BanMembers, true)) {
				this.container.logger.warn(
					`${header}  Can't ensure bans are synced in guild ${guild.name} (${guildId}) because I don't have the Ban Members permission!`,
				);
				continue;
			}

			// Fetch all guild members
			this.container.logger.info(
				`${header}  Fetching all members of guild ${guild.name} (${guild.id}) - this might take a while...`,
			);
			const members = await guild.members.fetch();

			for (const [id, member] of members) {
				const ban = banList.get(id);

				if (ban) {
					if (!member.bannable) {
						this.container.logger.warn(
							`${header}    Couldn't ban user ${member.user.tag} (${member.user.id}) in guild ${guild.name} (${
								guild.id
							}) because they are above me (previously banned for: ${ban.reason ?? 'no reason'})`,
						);
						continue;
					}

					const bannedIn = this.container.client.guilds.resolve(ban.guild_id)?.name ?? 'Unknown guild';

					// Member is present in guild but should be banned... bye felicia
					this.container.logger.info(
						`${header}    Banning user ${member.user.tag} (${id}) from guild ${guild.name} (${
							guild.id
						}) because they were banned in ${bannedIn} (${ban.guild_id}) for: ${ban.reason ?? 'no reason'}`,
					);

					await guild.bans.create(id, {
						deleteMessageSeconds: 0,
						reason: `BAN SYNC(${bannedIn}): ${ban.reason ?? 'No reason provided'}`,
					});
				}
			}
		}

		this.container.logger.info(`${header}Finished checking all bans across the guilds`);
	}
}
