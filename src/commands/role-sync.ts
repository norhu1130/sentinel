import { ApplyOptions } from '@sapphire/decorators';
import { PaginatedMessage } from '@sapphire/discord.js-utilities';
import { Subcommand, SubcommandMappingArray } from '@sapphire/plugin-subcommands';
import { chunk } from '@sapphire/utilities';
import { PermissionFlagsBits } from 'discord-api-types/v10';
import type { ApplicationCommandOptionChoiceData, Guild } from 'discord.js';
import { createInfoEmbed } from '../lib/utils/createInfoEmbed.js';
import { trimPretty } from '../lib/utils/trim.js';

@ApplyOptions<Subcommand.Options>({
	description: 'Manages role syncing across multiple servers.',
})
export class RoleSyncCommand extends Subcommand {
	public subcommandMappings: SubcommandMappingArray = [
		{
			type: 'method',
			name: 'add',
			chatInputRun: 'addSubcommand',
		},
		{
			type: 'method',
			name: 'remove',
			chatInputRun: 'removeSubcommand',
		},
		{
			type: 'method',
			name: 'list',
			chatInputRun: 'listSubcommand',
		},
	];

	public async addSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		const rawOriginServer = interaction.options.getString('origin_server', true);
		const rawOriginRole = interaction.options.getString('origin_role', true);
		const roleInThisServer = interaction.options.getRole('role_in_this_server', true);

		const resolvedOriginGuild = this._resolveGuildForOriginServerOption(rawOriginServer);

		if (!resolvedOriginGuild) {
			return interaction.reply({
				ephemeral: true,
				embeds: [createInfoEmbed(`Could not resolve the guild you provided.`)],
			});
		}

		const originRole = this._resolveRoleFromOriginRoleOptionInOriginServer(resolvedOriginGuild, rawOriginRole);

		if (!originRole) {
			return interaction.reply({
				ephemeral: true,
				embeds: [createInfoEmbed(`Could not resolve the role you provided in ${resolvedOriginGuild.name}.`)],
			});
		}

		if (roleInThisServer.managed) {
			return interaction.reply({
				ephemeral: true,
				embeds: [
					createInfoEmbed(
						`The role ${roleInThisServer.toString()} (${
							roleInThisServer.id
						}) is managed and I cannot add it to members.`,
					),
				],
			});
		}

		const me = await interaction.guild.members.fetch(this.container.client.user!.id);

		if (me.roles.highest.position <= roleInThisServer.position) {
			return interaction.reply({
				ephemeral: true,
				embeds: [
					createInfoEmbed(
						`I do not have permission to assign the role ${roleInThisServer} in this server as its above my highest role.`,
					),
				],
			});
		}

		const roleSyncEntry = await this.container.prisma.roleSync.create({
			data: {
				destination_guild_id: interaction.guildId,
				destination_role_id: roleInThisServer.id,
				origin_guild_id: resolvedOriginGuild.id,
				origin_role_id: originRole.id,
			},
		});

		await interaction.reply({
			embeds: [
				createInfoEmbed(
					`Created role sync entry with id \`${roleSyncEntry.id}\`!\n\nAs a reminder, members in the ${resolvedOriginGuild.name} server that receive or lose the role \`@${originRole.name}\` will have it synced in this server via the ${roleInThisServer} role.\n\n> I will process the new changes and follow up once done...`,
				),
			],
		});

		const originGuildMembers = await resolvedOriginGuild.members.fetch();
		const currentGuildMembers = await interaction.guild.members.fetch();

		for (const member of originGuildMembers.values()) {
			const memberInCurrentServer = currentGuildMembers.get(member.id);

			if (!memberInCurrentServer) {
				continue;
			}

			if (member.roles.cache.has(originRole.id)) {
				try {
					await memberInCurrentServer.roles.add(
						roleInThisServer,
						`Role sync: added role as member has the role in ${resolvedOriginGuild.name}`,
					);
				} catch (err) {
					await interaction.followUp({
						ephemeral: true,
						embeds: [
							createInfoEmbed(
								`Failed to role sync ${memberInCurrentServer.user.tag} (${memberInCurrentServer.user.id}): ${
									(err as any).message
								}`,
							),
						],
					});
				}
			} else {
				try {
					await memberInCurrentServer.roles.remove(
						roleInThisServer,
						`Role sync: removed role from member as they lack the role in ${resolvedOriginGuild.name}`,
					);
				} catch (err) {
					await interaction.followUp({
						ephemeral: true,
						embeds: [
							createInfoEmbed(
								`Failed to role sync ${memberInCurrentServer.user.tag} (${memberInCurrentServer.user.id}): ${
									(err as any).message
								}`,
							),
						],
					});
				}
			}
		}

		return interaction.followUp({
			embeds: [createInfoEmbed('Finished processing possible role syncs for the newly added role sync entry.')],
		});
	}

	public async removeSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		const rawRoleSyncEntry = interaction.options.getString('role_sync', true);
		const resolvedFilter = this._resolveRoleSyncDataFromRoleSyncOption(rawRoleSyncEntry);

		if (!resolvedFilter) {
			return interaction.reply({
				ephemeral: true,
				embeds: [createInfoEmbed(`Could not resolve the role sync entry you provided.`)],
			});
		}

		const entry = await this.container.prisma.roleSync.findFirst({
			where: resolvedFilter,
		});

		if (!entry) {
			return interaction.reply({
				ephemeral: true,
				embeds: [createInfoEmbed(`Could not find a role sync entry with the provided id.`)],
			});
		}

		await this.container.prisma.roleSync.delete({
			where: { id: entry.id },
		});

		const maybeGuild = this.container.client.guilds.resolve(entry.origin_guild_id);
		const maybeRole = maybeGuild?.roles.resolve(entry.origin_role_id);
		const maybeDestinationRole = interaction.guild.roles.resolve(entry.destination_role_id);

		return interaction.reply({
			embeds: [
				createInfoEmbed(
					`Deleted role sync entry with id \`${entry.id}\`!\n\nAs a reminder, members in the ${
						maybeGuild?.name ?? 'Unknown'
					} (${entry.origin_guild_id}) server that received or lost the role \`@${maybeRole?.name ?? 'Unknown'}\` ${
						entry.origin_role_id
					} will no longer have it synced in this server via the ${maybeDestinationRole?.toString() ?? 'Unknown'} (${
						entry.destination_role_id
					}) role.`,
				),
			],
		});
	}

	public async listSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		const roleSyncs = await this.container.prisma.roleSync.findMany({
			where: { destination_guild_id: interaction.guildId },
		});

		if (roleSyncs.length === 0) {
			return interaction.reply({
				ephemeral: true,
				embeds: [createInfoEmbed(`No role syncs have been setup in this server.`)],
			});
		}

		const paginated = new PaginatedMessage({ template: createInfoEmbed('') });

		const usableRoleSyncs: string[] = [];

		for (const entry of roleSyncs) {
			const originGuild = this.container.client.guilds.resolve(entry.origin_guild_id);

			if (!originGuild) {
				continue;
			}

			const originRole = originGuild.roles.resolve(entry.origin_role_id);

			if (!originRole) {
				continue;
			}

			const destinationRole = interaction.guild.roles.resolve(entry.destination_role_id);

			if (!destinationRole) {
				continue;
			}

			usableRoleSyncs.push(
				[
					`Origin server          : ${originGuild.name} (${originGuild.id})`,
					`▶️ Origin role        : @${originRole.name} (${originRole.id})`,
					`▶️ Role in this server: ${destinationRole.toString()} (${destinationRole.id})`,
				].join('\n'),
			);
		}

		if (usableRoleSyncs.length === 0) {
			return interaction.reply({
				ephemeral: true,
				embeds: [createInfoEmbed(`No role syncs have been setup in this server.`)],
			});
		}

		const chunks = chunk(usableRoleSyncs, 5);
		for (const usableChunk of chunks) {
			paginated.addPageEmbed((embed) =>
				embed.setDescription(usableChunk.join('\n\n')).setTitle('Here are the role syncs setup in this server:'),
			);
		}

		return paginated.run(interaction);
	}

	public async autocompleteRun(interaction: Subcommand.AutocompleteInteraction<'cached'>) {
		const focusedOption = interaction.options.getFocused(true);
		const input = focusedOption.value.toLowerCase();

		switch (focusedOption.name) {
			case 'origin_server': {
				const guilds = [...this.container.client.guilds.cache.values()].sort((a, b) => a.name.localeCompare(b.name));

				const startsWith: ApplicationCommandOptionChoiceData[] = [];
				const contains: ApplicationCommandOptionChoiceData[] = [];
				const other: ApplicationCommandOptionChoiceData[] = [];

				for (const guild of guilds) {
					if (startsWith.length + contains.length + other.length === 25) {
						break;
					}

					if (guild.name.toLowerCase().startsWith(input)) {
						startsWith.push({
							name: `⭐ ${guild.name} (${guild.id})`,
							value: guild.id,
						});

						continue;
					}

					if (guild.name.toLowerCase().includes(input)) {
						contains.push({
							name: `👀 ${guild.name} (${guild.id})`,
							value: guild.id,
						});

						continue;
					}

					other.push({
						name: `${guild.name} (${guild.id})`,
						value: guild.id,
					});
				}

				return interaction.respond([...startsWith, ...contains, ...other]);
			}
			case 'origin_role': {
				const rawOriginServer = interaction.options.getString('origin_server');

				if (!rawOriginServer) {
					return interaction.respond([
						{
							name: 'You need to select an origin server first.!',
							value: '__NO_SERVER_SPECIFIED__',
						},
					]);
				}

				const guild = this._resolveGuildForOriginServerOption(rawOriginServer);

				if (!guild) {
					return interaction.respond([
						{
							name: 'Could not find the origin server.!',
							value: '__NO_SERVER__',
						},
					]);
				}

				const startsWith: ApplicationCommandOptionChoiceData[] = [];
				const contains: ApplicationCommandOptionChoiceData[] = [];
				const other: ApplicationCommandOptionChoiceData[] = [];

				const roles = [...guild.roles.cache.values()].sort((a, b) => b.position - a.position);
				roles.pop();

				for (const role of roles) {
					if (startsWith.length + contains.length + other.length === 25) {
						break;
					}

					if (role.managed) {
						continue;
					}

					if (role.name.toLowerCase().startsWith(input)) {
						startsWith.push({
							name: `⭐ ${role.name} (${role.id})`,
							value: role.id,
						});

						continue;
					}

					if (role.name.toLowerCase().includes(input)) {
						contains.push({
							name: `👀 ${role.name} (${role.id})`,
							value: role.id,
						});

						continue;
					}

					other.push({
						name: `${role.name} (${role.id})`,
						value: role.id,
					});
				}

				return interaction.respond([...startsWith, ...contains, ...other]);
			}
			case 'role_sync': {
				// Role sync entries for this server
				const entries = await this.container.prisma.roleSync.findMany({
					where: { destination_guild_id: interaction.guildId },
				});

				const options: ApplicationCommandOptionChoiceData[] = [];

				for (const entry of entries) {
					if (options.length === 25) {
						break;
					}

					const guild = this.container.client.guilds.resolve(entry.origin_guild_id);

					const role = guild?.roles.resolve(entry.origin_role_id);

					const destinationRole = interaction.guild!.roles.resolve(entry.destination_role_id);

					if (!destinationRole) {
						continue;
					}

					const prefix =
						guild?.name.toLowerCase().includes(input) ||
						guild?.id === input ||
						role?.name.toLowerCase().includes(input) ||
						role?.id === input ||
						destinationRole.name.toLowerCase().includes(input) ||
						destinationRole.id === input
							? '📌 '
							: '';

					options.push({
						name: `${prefix}${trimPretty(guild?.name ?? 'Unknown', 7)} (${entry.origin_guild_id}), ${trimPretty(
							role?.name ?? 'Unknown',
							7,
						)} (${entry.origin_role_id}) → ${trimPretty(destinationRole.name, 7)} (${destinationRole.id})`,
						value: entry.id,
					});
				}

				return interaction.respond(options.sort((a) => (a.name.startsWith('📌') ? -1 : 1)));
			}
			default: {
				return interaction.respond([
					{
						name: 'Unknown option to autocomplete! Report this to the dev',
						value: '__UNKNOWN__',
					},
				]);
			}
		}
	}

	public override registerApplicationCommands(registry: Subcommand.Registry) {
		registry.registerChatInputCommand((roleSync) =>
			roleSync
				.setName(this.name)
				.setDescription(this.description)
				.setDMPermission(false)
				.setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
				.addSubcommand((add) =>
					add //
						.setName('add')
						.setDescription('Adds a role sync in this server')
						.addStringOption((guild) =>
							guild
								.setName('origin_server')
								.setDescription(
									'The origin server from which to monitor the role change (or server id if autocomplete fails)',
								)
								.setRequired(true)
								.setAutocomplete(true)
								.setMinLength(16),
						)
						.addStringOption((originRole) =>
							originRole
								.setName('origin_role')
								.setDescription('The origin role from the origin server to monitor (or role id if autocomplete fails)')
								.setRequired(true)
								.setAutocomplete(true)
								.setMinLength(16),
						)
						.addRoleOption((roleInServer) =>
							roleInServer
								.setName('role_in_this_server')
								.setDescription('The role in this server to add to members that get the origin role')
								.setRequired(true),
						),
				)
				.addSubcommand((remove) =>
					remove
						.setName('remove')
						.setDescription('Removes a role sync from the server')
						.addStringOption((role) =>
							role
								.setName('role_sync')
								.setDescription('The role sync to remove (or the entry id received from the list subcommand)')
								.setRequired(true)
								.setAutocomplete(true),
						),
				)
				.addSubcommand((list) => list.setName('list').setDescription('Lists all role syncs setup in this server')),
		);
	}

	protected _resolveGuildForOriginServerOption(option: string) {
		try {
			// Attempt to resolve by expecting an id
			BigInt(option);
			return this.container.client.guilds.resolve(option);
		} catch {
			// We assume the pattern is ours ([emoji] name (id))
			const results = option.match(/\((\d+)\)$/);

			return results ? this.container.client.guilds.resolve(results[1]) : null;
		}
	}

	protected _resolveRoleFromOriginRoleOptionInOriginServer(guild: Guild, option: string) {
		try {
			// Attempt to resolve by expecting an id
			BigInt(option);
			return guild.roles.resolve(option);
		} catch {
			// We assume the pattern is ours ([emoji] name (id))
			const results = option.match(/\((\d+)\)$/);

			return results ? guild.roles.resolve(results[1]) : null;
		}
	}

	protected _resolveRoleSyncDataFromRoleSyncOption(option: string) {
		// If it includes a (), it means we didn't get the id but the input string (Discord -.-)
		if (option.includes('(')) {
			const [
				maybeOriginGuildId, //
				maybeOriginRoleId,
				maybeDestinationRoleId,
			] = [...option.matchAll(/\((\d+)\)/g)];

			if (!maybeOriginGuildId || !maybeOriginRoleId || !maybeDestinationRoleId) {
				return null;
			}

			return {
				origin_guild_id: maybeOriginGuildId[1],
				origin_role_id: maybeOriginRoleId[1],
				destination_role_id: maybeDestinationRoleId[1],
			};
		}

		return {
			id: option,
		};
	}
}
