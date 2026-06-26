import type { Clan, CustomCommand } from '@prisma/client';
import { Subcommand, type SubcommandMappingArray } from '@sapphire/plugin-subcommands';
import {
	type ApplicationCommandOptionChoiceData,
	type AutocompleteInteraction,
	InteractionContextType,
	MessageFlags,
	PermissionFlagsBits,
} from 'discord.js';
import { recordClanEvent } from '../../../lib/utils/clanHistory.js';
import { createInfoEmbed } from '../../../lib/utils/createEmbed.js';
import { removeCustomCommandName } from '../customCommandCache.js';
import { CUSTOM_COMMAND_PREFIX, MAX_CUSTOM_COMMANDS_PER_CLAN, normalizeCommandName } from '../customCommandUtils.js';

/**
 * Moderator-facing tools for managing any clan's custom commands. Clans and commands are picked
 * through autocomplete; the owner-facing `/custom-command` command is restricted to clan owners.
 */
export class CustomCommandAdminCommand extends Subcommand {
	public subcommandMappings: SubcommandMappingArray = [
		{ type: 'method', name: 'list', chatInputRun: 'listSubcommand' },
		{ type: 'method', name: 'delete', chatInputRun: 'deleteSubcommand' },
	];

	public async listSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		const clanCustomRoleId = interaction.options.getString('clan', true);

		const clan = await this.findClan(interaction.guildId, clanCustomRoleId);
		if (!clan) {
			await interaction.editReply({ embeds: [createInfoEmbed('That clan could not be found.')] });
			return;
		}

		const commands = await this.container.prisma.customCommand.findMany({
			where: { guildId: interaction.guildId, clanCustomRoleId },
			orderBy: { name: 'asc' },
		});

		const clanName = this.clanName(interaction, clanCustomRoleId);

		if (commands.length === 0) {
			await interaction.editReply({
				embeds: [createInfoEmbed(`**${clanName}** doesn't have any custom commands.`)],
			});
			return;
		}

		const lines = commands.map((command: CustomCommand) => {
			const parts: string[] = [];
			if (command.text) {
				parts.push('text');
			}

			if (command.mediaData) {
				parts.push('upload');
			}

			if (command.mediaUrl) {
				parts.push('link');
			}

			return `\`${CUSTOM_COMMAND_PREFIX}${command.name}\` — ${parts.join(' + ') || 'empty'} (by <@${command.createdBy}>)`;
		});

		await interaction.editReply({
			embeds: [
				createInfoEmbed(
					`Custom commands for **${clanName}** (${commands.length}/${MAX_CUSTOM_COMMANDS_PER_CLAN}):\n\n${lines.join('\n')}`,
				),
			],
		});
	}

	public async deleteSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		const clanCustomRoleId = interaction.options.getString('clan', true);
		const name = normalizeCommandName(interaction.options.getString('command', true));

		const deleted = await this.container.prisma.customCommand
			.delete({
				where: {
					guildId_clanCustomRoleId_name: {
						guildId: interaction.guildId,
						clanCustomRoleId,
						name,
					},
				},
			})
			.catch(() => null);

		if (!deleted) {
			await interaction.editReply({
				embeds: [createInfoEmbed(`That clan doesn't have a \`${CUSTOM_COMMAND_PREFIX}${name}\` command.`)],
			});
			return;
		}

		await removeCustomCommandName(interaction.guildId, name);

		await recordClanEvent({
			guildId: interaction.guildId,
			customRoleId: clanCustomRoleId,
			clanName: this.clanName(interaction, clanCustomRoleId),
			actorUserId: interaction.user.id,
			eventType: 'CustomCommandDeleted',
			reason: 'deleted by a moderator',
			metadata: { command: name, createdBy: deleted.createdBy },
		});

		await interaction.editReply({
			embeds: [
				createInfoEmbed(
					`Deleted \`${CUSTOM_COMMAND_PREFIX}${name}\` from **${this.clanName(interaction, clanCustomRoleId)}**.`,
				),
			],
		});
	}

	public override async autocompleteRun(interaction: AutocompleteInteraction<'cached'>) {
		const focused = interaction.options.getFocused(true);

		if (focused.name === 'clan') {
			return this.autocompleteClans(interaction, focused.value);
		}

		if (focused.name === 'command') {
			return this.autocompleteCommands(interaction, focused.value);
		}

		return interaction.respond([]);
	}

	public override registerApplicationCommands(registry: Subcommand.Registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName(this.name)
				.setDescription('Moderator tools for managing clan custom commands.')
				.setContexts(InteractionContextType.Guild)
				.setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
				.addSubcommand((subcommand) =>
					subcommand
						.setName('list')
						.setDescription("List a clan's custom commands.")
						.addStringOption((option) =>
							option
								.setName('clan')
								.setDescription('The clan whose commands to list')
								.setRequired(true)
								.setAutocomplete(true),
						),
				)
				.addSubcommand((subcommand) =>
					subcommand
						.setName('delete')
						.setDescription("Delete a clan's custom command.")
						.addStringOption((option) =>
							option
								.setName('clan')
								.setDescription('The clan that owns the command')
								.setRequired(true)
								.setAutocomplete(true),
						)
						.addStringOption((option) =>
							option
								.setName('command')
								.setDescription('The command to delete')
								.setRequired(true)
								.setAutocomplete(true),
						),
				),
		);
	}

	private async autocompleteClans(interaction: AutocompleteInteraction<'cached'>, value: string) {
		const clans = await this.container.prisma.clan.findMany({
			where: { guildId: interaction.guildId },
		});

		const input = value.toLowerCase();

		const options: ApplicationCommandOptionChoiceData[] = clans
			.map((clan: Clan) => ({
				name: this.clanName(interaction, clan.customRoleId),
				value: clan.customRoleId,
			}))
			.filter((choice) => choice.name.toLowerCase().includes(input))
			.slice(0, 25);

		return interaction.respond(options);
	}

	private async autocompleteCommands(interaction: AutocompleteInteraction<'cached'>, value: string) {
		const clanCustomRoleId = interaction.options.getString('clan');

		if (!clanCustomRoleId) {
			return interaction.respond([{ name: 'Pick a clan in the "clan" option first', value: 'none' }]);
		}

		const input = normalizeCommandName(value);

		const commands = await this.container.prisma.customCommand.findMany({
			where: { guildId: interaction.guildId, clanCustomRoleId },
			orderBy: { name: 'asc' },
			take: 25,
		});

		const options: ApplicationCommandOptionChoiceData[] = commands
			.filter((command: CustomCommand) => command.name.includes(input))
			.slice(0, 25)
			.map((command: CustomCommand) => ({
				name: `${CUSTOM_COMMAND_PREFIX}${command.name}`,
				value: command.name,
			}));

		return interaction.respond(options);
	}

	private async findClan(guildId: string, customRoleId: string): Promise<Clan | null> {
		return this.container.prisma.clan.findFirst({ where: { guildId, customRoleId } });
	}

	private clanName(
		interaction: AutocompleteInteraction<'cached'> | Subcommand.ChatInputCommandInteraction<'cached'>,
		customRoleId: string,
	): string {
		return interaction.guild.roles.cache.get(customRoleId)?.name ?? customRoleId;
	}
}
