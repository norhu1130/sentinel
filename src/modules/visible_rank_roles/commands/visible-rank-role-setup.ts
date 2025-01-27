import { RoleSyncType } from '@prisma/client';
import { PaginatedMessage } from '@sapphire/discord.js-utilities';
import { Subcommand, type SubcommandMappingArray } from '@sapphire/plugin-subcommands';
import { chunk } from '@sapphire/utilities';
import { PermissionFlagsBits, type ApplicationCommandOptionChoiceData } from 'discord.js';
import { createInfoEmbed } from '../../../lib/utils/createEmbed.js';
import { trimPretty } from '../../../lib/utils/trim.js';

export class VisibleRankRoleSetup extends Subcommand {
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
		const originRole = interaction.options.getRole('origin_role', true);
		const toggleableRole = interaction.options.getRole('visible_role', true);

		if (toggleableRole.managed) {
			await interaction.reply({
				ephemeral: true,
				embeds: [
					createInfoEmbed(
						`The role ${toggleableRole.toString()} (${
							toggleableRole.id
						}) is managed and I cannot add it to members.`,
					),
				],
			});

			return;
		}

		const me = await interaction.guild.members.fetch(this.container.client.user!.id);

		if (me.roles.highest.position <= toggleableRole.position) {
			await interaction.reply({
				ephemeral: true,
				embeds: [
					createInfoEmbed(
						`I do not have permission to assign the role ${toggleableRole} in this server as its above my highest role.`,
					),
				],
			});

			return;
		}

		const existingRoleSync = await this.container.prisma.roleSync.findFirst({
			where: {
				origin_guild_id: interaction.guildId,
				origin_role_id: originRole.id,
				destination_role_id: toggleableRole.id,
				type: RoleSyncType.VisibleRank,
			},
		});

		if (existingRoleSync) {
			await interaction.reply({
				ephemeral: true,
				embeds: [
					createInfoEmbed(
						`There is already a role sync entry for the role ${originRole} (${originRole.id}) and ${toggleableRole} (${toggleableRole.id})`,
					),
				],
			});

			return;
		}

		const roleSyncEntry = await this.container.prisma.roleSync.create({
			data: {
				destination_guild_id: interaction.guildId,
				destination_role_id: toggleableRole.id,
				origin_guild_id: interaction.guildId,
				origin_role_id: originRole.id,
				type: RoleSyncType.VisibleRank,
			},
		});

		await interaction.reply({
			embeds: [
				createInfoEmbed(
					`Created role sync entry with id \`${roleSyncEntry.id}\`!\n\nAs a reminder, members that have or lose the role ${originRole.toString()} will have be able to toggle its visibility and get the ${toggleableRole} role.\n\nI will update the role that users will get to match the original one now...`,
				),
			],
		});

		try {
			await toggleableRole.edit({
				name: originRole.name,
				color: originRole.color,
				icon: originRole.iconURL({ size: 4_096 }),
				unicodeEmoji: originRole.unicodeEmoji,
				reason: `Role sync entry created by ${interaction.user.tag} (${interaction.user.id})`,
			});

			await interaction.followUp({
				embeds: [
					createInfoEmbed(
						`Updated the role ${toggleableRole.toString()} (${toggleableRole.id}) to match the origin role ${originRole.toString()} (${originRole.id}).`,
					),
				],
			});
		} catch (error: any) {
			this.container.logger.error(`[VISIBLE RANK ROLE SETUP ADD]`, error);
			await interaction.followUp({
				embeds: [
					createInfoEmbed(
						`I was unable to update the role ${toggleableRole.toString()} (${toggleableRole.id}) to match the origin role ${originRole.toString()} (${originRole.id}).`,
					).addFields({
						name: 'Error',
						value: `\`\`\`js\n${error.message}\n\`\`\``,
					}),
				],
			});
		}
	}

	public async removeSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		const rawRoleSyncEntry = interaction.options.getString('role_sync', true);
		const resolvedFilter = this._resolveRoleSyncDataFromRoleSyncOption(rawRoleSyncEntry);

		if (!resolvedFilter) {
			return interaction.reply({
				ephemeral: true,
				embeds: [createInfoEmbed(`Could not resolve the toggleable role sync entry you provided.`)],
			});
		}

		const entry = await this.container.prisma.roleSync.findFirst({
			where: resolvedFilter,
		});

		if (!entry) {
			return interaction.reply({
				ephemeral: true,
				embeds: [createInfoEmbed(`Could not find a toggleable role sync entry with the provided id.`)],
			});
		}

		await this.container.prisma.roleSync.delete({
			where: { id: entry.id },
		});

		const maybeRole = interaction.guild.roles.resolve(entry.origin_role_id);
		const maybeDestinationRole = interaction.guild.roles.resolve(entry.destination_role_id);

		return interaction.reply({
			embeds: [
				createInfoEmbed(
					`Deleted toggleable role sync entry with id \`${entry.id}\`!\n\nAs a reminder, members that have the \`@${maybeRole?.toString() ?? 'Unknown'}\` ${
						entry.origin_role_id
					} will no longer be able to toggle its visibility  and receive the ${maybeDestinationRole?.toString() ?? 'Unknown'} (${
						entry.destination_role_id
					}) role.`,
				),
			],
		});
	}

	public async listSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		const roleSyncs = await this.container.prisma.roleSync.findMany({
			where: { origin_guild_id: interaction.guildId, type: RoleSyncType.VisibleRank },
		});

		if (roleSyncs.length === 0) {
			await interaction.reply({
				ephemeral: true,
				embeds: [createInfoEmbed(`No toggleable role syncs have been setup in this server.`)],
			});

			return;
		}

		const paginated = new PaginatedMessage({ template: createInfoEmbed(null) });

		const usableRoleSyncs: string[] = [];

		for (const entry of roleSyncs) {
			const originRole = interaction.guild.roles.resolve(entry.origin_role_id);

			if (!originRole) {
				continue;
			}

			const destinationRole = interaction.guild.roles.resolve(entry.destination_role_id);

			if (!destinationRole) {
				continue;
			}

			usableRoleSyncs.push(
				[
					`▶️ Origin role     : ${originRole.toString()} (${originRole.id})`,
					`▶️ Toggleable role : ${destinationRole.toString()} (${destinationRole.id})`,
				].join('\n'),
			);
		}

		if (usableRoleSyncs.length === 0) {
			await interaction.reply({
				ephemeral: true,
				embeds: [createInfoEmbed(`No toggleable role syncs have been setup in this server.`)],
			});
			return;
		}

		const chunks = chunk(usableRoleSyncs, 5);
		for (const usableChunk of chunks) {
			paginated.addPageEmbed((embed) =>
				embed
					.setDescription(usableChunk.join('\n\n'))
					.setTitle('Here are the toggleable role syncs setup in this server:'),
			);
		}

		await paginated.run(interaction);
	}

	public override async autocompleteRun(interaction: Subcommand.AutocompleteInteraction<'cached'>) {
		const focusedOption = interaction.options.getFocused(true);
		const input = focusedOption.value.toLowerCase();

		switch (focusedOption.name) {
			case 'role_sync': {
				// Role sync entries for this server
				const entries = await this.container.prisma.roleSync.findMany({
					where: { origin_guild_id: interaction.guildId, type: RoleSyncType.VisibleRank },
				});

				const options: ApplicationCommandOptionChoiceData[] = [];

				for (const entry of entries) {
					if (options.length === 25) {
						break;
					}

					const role = interaction.guild.roles.resolve(entry.origin_role_id);
					const destinationRole = interaction.guild.roles.resolve(entry.destination_role_id);

					if (!role || !destinationRole) {
						continue;
					}

					const prefix =
						(
							role?.name.toLowerCase().includes(input) ||
							role?.id === input ||
							destinationRole.name.toLowerCase().includes(input) ||
							destinationRole.id === input
						) ?
							'📌 '
						:	'';

					options.push({
						name: `${prefix}${trimPretty(
							role.name,
							9,
						)} (${entry.origin_role_id}) → ${trimPretty(destinationRole.name, 9)} (${destinationRole.id})`,
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
		registry.registerChatInputCommand((builder) =>
			builder
				.setName(this.name)
				.setDescription('Lets you setup the link between the rank role and a toggleable visible role')
				.setDMPermission(false)
				.setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
				.addSubcommand((add) =>
					add //
						.setName('add')
						.setDescription('Adds a role sync in this server')
						.addRoleOption((originRole) =>
							originRole
								.setName('origin_role')
								.setDescription('The origin role from this server')
								.setRequired(true),
						)
						.addRoleOption((roleInServer) =>
							roleInServer
								.setName('visible_role')
								.setDescription(
									'The role in this server that members can toggle on if they have the origin role',
								)
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
								.setDescription(
									'The role sync to remove (or the entry id received from the list subcommand)',
								)
								.setRequired(true)
								.setAutocomplete(true),
						),
				)
				.addSubcommand((list) =>
					list.setName('list').setDescription('Lists all role syncs setup in this server'),
				),
		);
	}

	protected _resolveRoleSyncDataFromRoleSyncOption(option: string) {
		// If it includes a (), it means we didn't get the id but the input string (Discord -.-)
		if (option.includes('(')) {
			// eslint-disable-next-line prefer-named-capture-group
			const [maybeOriginRoleId, maybeDestinationRoleId] = [...option.matchAll(/\((\d+)\)/g)];

			if (!maybeOriginRoleId || !maybeDestinationRoleId) {
				return null;
			}

			return {
				origin_role_id: maybeOriginRoleId[1],
				destination_role_id: maybeDestinationRoleId[1],
				type: RoleSyncType.VisibleRank,
			};
		}

		return {
			id: option,
			type: RoleSyncType.VisibleRank,
		};
	}
}
