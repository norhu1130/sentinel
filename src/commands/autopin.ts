// @ts-ignore We cannot use import type here because we use this import to create an alias
import { Prisma } from '@prisma/client';
import AutoPinCreateInput = Prisma.AutoPinCreateInput;
import { inlineCode, time } from '@discordjs/builders';
import { ApplyOptions } from '@sapphire/decorators';
import { Subcommand, SubcommandMappingArray } from '@sapphire/plugin-subcommands';
import { Duration, Time } from '@sapphire/time-utilities';
import { ChannelType, PermissionFlagsBits } from 'discord-api-types/v10';
import { AttachmentBuilder, GuildTextBasedChannel } from 'discord.js';
import { durationFormat } from '../lib/utils.js';
import { createInfoEmbed } from '../lib/utils/createInfoEmbed.js';

@ApplyOptions<Subcommand.Options>({
	description: 'Manages messages that should be kept at the bottom of a channel',
})
export class AutoPinCommand extends Subcommand {
	public subcommandMappings: SubcommandMappingArray = [
		{
			type: 'method',
			name: 'create',
			chatInputRun: 'createSubcommand',
		},
		{
			type: 'method',
			name: 'delete',
			chatInputRun: 'deleteSubcommand',
		},
		{
			type: 'method',
			name: 'list',
			chatInputRun: 'listSubcommand',
		},
		{
			type: 'method',
			name: 'show',
			chatInputRun: 'showSubcommand',
		},
	];

	public async createSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		const channel = interaction.options.getChannel('channel', true) as GuildTextBasedChannel;
		const content = interaction.options.getString('content', true).replaceAll('{newline}', '\n');
		const buttonLink = interaction.options.getString('button_link');
		const buttonLabel = interaction.options.getString('button_label');
		const rawCheckEvery = interaction.options.getString('check_every', true);

		const me = await interaction.guild.members.fetch(this.container.client.user!.id);

		if (
			me.permissionsIn(channel).missing([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages], true)
				.length !== 0
		) {
			await interaction.reply({
				ephemeral: true,
				embeds: [createInfoEmbed(`I cannot see or send messages in the <#${channel.id}> channel!`)],
			});

			return;
		}

		if (me.permissionsIn(channel).missing(PermissionFlagsBits.ReadMessageHistory, true).length !== 0) {
			await interaction.reply({
				ephemeral: true,
				embeds: [
					createInfoEmbed(
						`I don't have the permission to read the message history in <#${channel.id}>! Give me that permission and run the command again!`,
					),
				],
			});

			return;
		}

		// Get the seconds
		const checkEveryOffset = new Duration(isNaN(Number(rawCheckEvery)) ? rawCheckEvery : `${rawCheckEvery} minutes`)
			.offset;

		if (isNaN(checkEveryOffset)) {
			await interaction.reply({
				ephemeral: true,
				embeds: [
					createInfoEmbed(`The time interval you entered does not seem to be valid. Try something like "15 minutes"!`),
				],
			});

			return;
		}

		const parsedCheckEvery = checkEveryOffset / Time.Second;
		const firstCheck = new Date();
		const autoPinData: AutoPinCreateInput = {
			channel_id: channel.id,
			guild_id: interaction.guildId,
			check_every_seconds: parsedCheckEvery,
			content,
			last_check: firstCheck,
		};

		if (buttonLink && buttonLabel) {
			autoPinData.button_link = buttonLink;
			autoPinData.button_label = buttonLabel;
		}

		const entry = await this.container.prisma.autoPin.create({ data: autoPinData });
		const firstCheckFormatted = time(new Date(firstCheck.getTime() + parsedCheckEvery * Time.Second), 'R');

		await interaction.reply({
			embeds: [
				createInfoEmbed(
					`Auto-pinned message with id ${inlineCode(
						entry.id,
					)} created.\n\n> The next check will happen in ${firstCheckFormatted}`,
				),
			],
		});
	}

	public async deleteSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		const code = interaction.options.getString('id', true);

		const entry = await this.container.prisma.autoPin.findFirst({
			where: { id: code },
		});

		if (!entry || entry.guild_id !== interaction.guildId) {
			await interaction.reply({
				ephemeral: true,
				embeds: [createInfoEmbed(`No auto-pinned message with id ${inlineCode(code)} found`)],
			});

			return;
		}

		await this.container.prisma.autoPin.delete({ where: { id: code } });

		const fields = [
			{ name: 'Channel its checked in', value: `<#${entry.channel_id}> (${entry.channel_id})`, inline: true },
			{ name: 'Check every', value: durationFormat.format(Number(entry.check_every_seconds) * 1000), inline: true },
		];

		if (entry.button_link) {
			fields.push({ name: 'Link button URL', value: entry.button_link, inline: true });
		}

		await interaction.reply({
			embeds: [
				createInfoEmbed(
					`Auto-pinned message ${inlineCode(code)} deleted. Attached is the content of the message.`,
				).addFields(fields),
			],
		});

		const buffer = Buffer.from(entry.content, 'utf8');

		await interaction.followUp({
			files: [new AttachmentBuilder(buffer, { name: `auto-pinned-message-${entry.id}.md` })],
		});
	}

	public async listSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		const autoPins = await this.container.prisma.autoPin.findMany({
			where: { guild_id: interaction.guildId },
		});

		if (autoPins.length === 0) {
			await interaction.reply({
				ephemeral: true,
				embeds: [createInfoEmbed('There are no auto-pinned messages configured in this guild')],
			});

			return;
		}

		const listOfIds = autoPins.map(
			(autoPin) =>
				`- ${inlineCode(autoPin.id)} - <#${autoPin.channel_id}> (${autoPin.channel_id})\n└─ Next check: ${time(
					new Date(autoPin.last_check.getTime() + Number(autoPin.check_every_seconds * 1000n)),
					'R',
				)}`,
		);

		await interaction.reply({
			embeds: [
				createInfoEmbed(listOfIds.join('\n\n')).setTitle(
					`There are ${autoPins.length} auto-pinned messages in this server`,
				),
			],
		});
	}

	public async showSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		const code = interaction.options.getString('id', true);

		const entry = await this.container.prisma.autoPin.findFirst({
			where: { id: code },
		});

		if (!entry || entry.guild_id !== interaction.guildId) {
			await interaction.reply({
				ephemeral: true,
				embeds: [createInfoEmbed(`No auto-pinned message with id ${inlineCode(code)} found`)],
			});

			return;
		}

		await interaction.reply({
			embeds: [
				createInfoEmbed(
					[`Content for auto-pinned message ${inlineCode(entry.id)}`, '', entry.content].join('\n'),
				).addFields([
					{ name: 'ID', value: inlineCode(entry.id), inline: true },
					{ name: 'Channel its checked in', value: `<#${entry.channel_id}> (${entry.channel_id})`, inline: true },
					{ name: 'Check every', value: durationFormat.format(Number(entry.check_every_seconds) * 1000) },
				]),
			],
		});
	}

	public override registerApplicationCommands(registry: Subcommand.Registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName(this.name)
				.setDescription(this.description)
				.setDMPermission(false)
				.setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
				.addSubcommand((create) =>
					create
						.setName('create')
						.setDescription('Create a new auto-pinned message')
						.addChannelOption((channel) =>
							channel
								.setName('channel')
								.setDescription('The channel in which to send the message')
								.setRequired(true)
								.addChannelTypes(
									ChannelType.GuildText,
									ChannelType.GuildNews,
									ChannelType.GuildNewsThread,
									ChannelType.GuildPrivateThread,
									ChannelType.GuildPublicThread,
									ChannelType.GuildVoice,
								),
						)
						.addStringOption((content) =>
							content
								.setName('content')
								.setDescription('The message to send in the channel (for now use {newline} for new lines)')
								.setRequired(true),
						)
						.addStringOption((checkEvery) =>
							checkEvery
								.setName('check_every')
								.setDescription('How often should the channel be checked to repost the message (ex.: 1 hour 5 minutes)')
								.setRequired(true),
						)
						.addStringOption((buttonLink) =>
							buttonLink
								.setName('button_link')
								.setDescription('If you want the message to have a link button, enter the link it should go to')
								.setRequired(false),
						)
						.addStringOption((buttonLabel) =>
							buttonLabel
								.setName('button_label')
								.setDescription('If you want the message to have a link button, enter the label it should have')
								.setRequired(false),
						),
				)
				.addSubcommand((deleteSubCmd) =>
					deleteSubCmd
						.setName('delete')
						.setDescription('Deletes an auto-pinned message')
						.addStringOption((id) =>
							id.setName('id').setDescription('The id of the auto-pinned message to delete').setRequired(true),
						),
				)
				.addSubcommand((list) =>
					list.setName('list').setDescription('Lists all auto-pinned messages created in this server'),
				)
				.addSubcommand((show) =>
					show
						.setName('show')
						.setDescription('Shows the content for an auto-pinned message')
						.addStringOption((id) =>
							id.setName('id').setDescription('The id of the auto-pinned message to show').setRequired(true),
						),
				),
		);
	}
}
