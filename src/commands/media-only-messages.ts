import { ApplyOptions } from '@sapphire/decorators';
import { Subcommand, SubcommandMappingArray } from '@sapphire/plugin-subcommands';
import { PermissionFlagsBits } from 'discord-api-types/v10';
import { createInfoEmbed } from '../lib/utils/createInfoEmbed.js';

@ApplyOptions<Subcommand.Options>({
	description: 'Manages the channels that require an attachment to be sent with the message',
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
		{
			type: 'method',
			name: 'list',
			chatInputRun: 'listSubcommand',
		},
	];

	public async enableSubcommand(interaction: Subcommand.ChatInputInteraction<'cached'>) {
		const channel = interaction.options.getChannel('channel', true);

		const existent = await this.container.prisma.messageOnlyChannel.findFirst({
			where: { channel_id: channel.id },
		});

		if (existent) {
			await interaction.reply({
				ephemeral: true,
				embeds: [
					createInfoEmbed(
						`The <#${channel.id}> channel is already configured to require attachments when sending messages`,
					),
				],
			});

			return;
		}

		await this.container.prisma.messageOnlyChannel.create({
			data: { channel_id: channel.id, guild_id: interaction.guildId },
		});

		await interaction.reply({
			embeds: [
				createInfoEmbed(`The <#${channel.id}> channel is now configured to require attachments when sending messages`),
			],
		});
	}

	public async disableSubcommand(interaction: Subcommand.ChatInputInteraction<'cached'>) {
		const channel = interaction.options.getChannel('channel', true);

		const existent = await this.container.prisma.messageOnlyChannel.findFirst({
			where: { channel_id: channel.id },
		});

		if (!existent) {
			await interaction.reply({
				ephemeral: true,
				embeds: [
					createInfoEmbed(
						`The <#${channel.id}> channel is not configured to require attachments when sending messages`,
					),
				],
			});

			return;
		}

		await this.container.prisma.messageOnlyChannel.delete({
			where: { channel_id: channel.id },
		});

		await interaction.reply({
			embeds: [
				createInfoEmbed(
					`The <#${channel.id}> channel is no longer configured to require attachments when sending messages`,
				),
			],
		});
	}

	public async listSubcommand(interaction: Subcommand.ChatInputInteraction<'cached'>) {
		const channels = await this.container.prisma.messageOnlyChannel.findMany({
			where: { guild_id: interaction.guildId },
		});

		if (!channels.length) {
			await interaction.reply({
				ephemeral: true,
				embeds: [createInfoEmbed('No channels are configured to require attachments when sending messages')],
			});

			return;
		}

		const channelIds = channels.map((channel) => channel.channel_id);

		const embed = createInfoEmbed(
			[
				`The following channels are configured to require attachments when sending messages:\n`,
				...channelIds.map((id) => `- <#${id}> (${id})`),
			].join('\n'),
		);

		await interaction.reply({ embeds: [embed] });
	}

	public override registerApplicationCommands(registry: Subcommand.Registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName(this.name)
				.setDescription(this.description)
				.setDMPermission(false)
				.setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
				.addSubcommand((enable) =>
					enable
						.setName('enable')
						.setDescription('Enables the attachment requirement for messages in a channel')
						.addChannelOption((channel) =>
							channel
								.setName('channel')
								.setDescription('The channel in which to enable the requirement')
								.setRequired(true),
						),
				)
				.addSubcommand((disable) =>
					disable
						.setName('disable')
						.setDescription('Disables the attachment requirement for messages in a channel')
						.addChannelOption((channel) =>
							channel
								.setName('channel')
								.setDescription('The channel in which to disable the requirement')
								.setRequired(true),
						),
				)
				.addSubcommand((list) =>
					list.setName('list').setDescription('Lists all channels that require attachments when sending messages'),
				),
		);
	}
}
