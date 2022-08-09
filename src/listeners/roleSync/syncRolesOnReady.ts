import { ApplyOptions } from '@sapphire/decorators';
import { Events, Listener } from '@sapphire/framework';
import { Collection, Guild, GuildMember } from 'discord.js';

const header = '[ROLE SYNC] ';

@ApplyOptions<Listener.Options>({ event: Events.ClientReady })
export class SyncRolesOnReady extends Listener {
	public async run() {
		const entries = await this.container.prisma.roleSync.findMany();

		// Don't run for no entries
		if (entries.length === 0) {
			return;
		}

		this.container.logger.info(`${header}Starting role sync check...`);

		// Find all guild ids we care about
		const guildIds = new Set<string>();
		for (const entry of entries) {
			guildIds.add(entry.origin_guild_id);
			guildIds.add(entry.destination_guild_id);
		}

		// Fetch all members for these guilds
		const membersByGuild = new Collection<Guild, Collection<string, GuildMember>>();

		for (const id of guildIds) {
			const guild = this.container.client.guilds.resolve(id);
			if (!guild) {
				continue;
			}

			const members = await guild.members.fetch();

			membersByGuild.set(guild, members);
		}

		// ACTUAL SYNC //
		for (const [guild, members] of membersByGuild.entries()) {
			// Go through each role entry for this guild
			for (const entry of entries) {
				// Ensure the origin guild id is the one we want
				if (entry.origin_guild_id !== guild.id) {
					continue;
				}

				// Find the members for the destination guild
				const destinationGuild = membersByGuild.findKey(
					(_, innerGuild) => innerGuild.id === entry.destination_guild_id,
				);

				if (!destinationGuild) {
					continue;
				}

				const destinationMembers = membersByGuild.get(destinationGuild)!;

				for (const originMember of members.values()) {
					// See if they are a member in the guild, and add/remove the role if we can
					const destinationMember = destinationMembers.get(originMember.id);
					if (!destinationMember) {
						continue;
					}

					if (originMember.roles.cache.has(entry.origin_role_id)) {
						try {
							await destinationMember.roles.add(
								entry.destination_role_id,
								`Role sync: adding role as they have it in ${guild.name}`,
							);
						} catch (err) {
							this.container.logger.warn(
								`${header}  Failed to add role ${entry.destination_role_id} to ${destinationMember.user.tag}`,
								err,
							);
						}
					} else {
						try {
							await destinationMember.roles.remove(
								entry.destination_role_id,
								`Role sync: removing role as they do not have it in ${guild.name}`,
							);
						} catch (err) {
							this.container.logger.warn(
								`${header}  Failed to remove role ${entry.destination_role_id} to ${destinationMember.user.tag}`,
								err,
							);
						}
					}
				}
			}
		}

		this.container.logger.info(`${header}Role sync check complete!`);
	}
}
