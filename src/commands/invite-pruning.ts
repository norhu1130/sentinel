import { ApplyOptions } from '@sapphire/decorators';
import { Subcommand, SubcommandMappingArray } from '@sapphire/plugin-subcommands';
import { PermissionFlagsBits } from 'discord-api-types/v10';
import { createInfoEmbed } from '../lib/utils/createInfoEmbed.js';

@ApplyOptions<Subcommand.Options>({
	description: 'Manages the automatic invite pruning in this server',
})
export class MediaOnlyMessagesCommand extends Subcommand {
	public subcommandMappings: SubcommandMappingArray = [
		{
			type: 'method',
			name: 'enable',
			chatInputRun: 'enableSubcommand',
		},
		{
			type: 'method',
			name: 'disable',
			chatInputRun: 'disableSubcommand',
		},
	];

	public async enableSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		const existent = await this.container.prisma.invitePrune.findFirst({
			where: { guild_id: interaction.guildId },
		});

		if (existent) {
			await interaction.reply({
				ephemeral: true,
				embeds: [createInfoEmbed(`Automatic invite pruning is already enabled in this server`)],
			});

			return;
		}

		await this.container.prisma.invitePrune.create({
			data: { guild_id: interaction.guildId },
		});

		await interaction.reply({
			embeds: [createInfoEmbed(`Automatic invite pruning has been enabled in this server`)],
		});
	}

	public async disableSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		const existent = await this.container.prisma.invitePrune.findFirst({
			where: { guild_id: interaction.guildId },
		});

		if (!existent) {
			await interaction.reply({
				ephemeral: true,
				embeds: [createInfoEmbed(`Automatic invite pruning is not enabled in this server`)],
			});

			return;
		}

		await this.container.prisma.invitePrune.delete({
			where: { guild_id: interaction.guildId },
		});

		await interaction.reply({
			embeds: [createInfoEmbed(`Automatic invite pruning has been disabled in this server`)],
		});
	}

	public override registerApplicationCommands(registry: Subcommand.Registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName(this.name)
				.setDescription(this.description)
				.setDMPermission(false)
				.setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
				.addSubcommand((enable) =>
					enable.setName('enable').setDescription('Enables automatic invite pruning for this server'),
				)
				.addSubcommand((disable) =>
					disable.setName('disable').setDescription('Disables automatic invite pruning for this server'),
				),
		);
	}
}
