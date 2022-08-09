import { time } from '@discordjs/builders';
import type { Poll } from '@prisma/client';
import { ApplyOptions } from '@sapphire/decorators';
import { Subcommand, SubcommandMappingArray } from '@sapphire/plugin-subcommands';
import { Duration } from '@sapphire/time-utilities';
import { chunk } from '@sapphire/utilities';
import { PermissionFlagsBits } from 'discord-api-types/v10';
import { Constants, MessageActionRow, MessageButton } from 'discord.js';
import { createInfoEmbed } from '../lib/utils/createInfoEmbed.js';
import { trimPretty } from '../lib/utils/trim.js';

@ApplyOptions<Subcommand.Options>({
	description: 'Poll your members if pineapple belongs on pizza...or something',
})
export class PollCommand extends Subcommand {
	public subcommandMappings: SubcommandMappingArray = [
		{
			type: 'method',
			name: 'create',
			chatInputRun: 'createSubcommand',
		},
	];

	public async createSubcommand(interaction: Subcommand.ChatInputInteraction<'cached'>) {
		const question = interaction.options.getString('question', true);
		const rawEndsAfter = interaction.options.getString('ends_after', true);

		const pollOptions = interaction.options.data[0]
			.options!.filter((option) => option.name.startsWith('option_'))
			.sort()
			.map((opt) => opt.value) as string[];

		const parsedEndAfter = new Duration(rawEndsAfter).fromNow;

		const poll = await this.container.prisma.poll.create({
			data: {
				author_id: interaction.user.id,
				guild_id: interaction.guildId,
				channel_id: interaction.channelId,
				ends_at: parsedEndAfter,
				question,
				options: pollOptions,
				message_id: 'UPDATE_ME',
			},
		});

		const message = await interaction.channel!.send({
			embeds: [
				createInfoEmbed(`**A poll has been created!** It ends **${time(parsedEndAfter, 'R')}**\n\n${question}`)
					.setFooter({
						text: `Poll started by ${interaction.user.tag}`,
					})
					.setFields(
						pollOptions.map((option, index) => ({
							name: `Option ${index + 1}`,
							value: option,
							inline: true,
						})),
					),
			],
			components: this._generatePollComponents(poll),
		});

		await this.container.prisma.poll.update({
			where: { id: poll.id },
			data: { message_id: message.id },
		});

		await this.container.client.schedule.add('endPoll', parsedEndAfter, JSON.stringify({ pollId: poll.id }));

		await interaction.reply({
			ephemeral: true,
			embeds: [createInfoEmbed(`The poll with id \`${poll.id}\` was created! It will end at ${time(parsedEndAfter)}`)],
		});
	}

	public override registerApplicationCommands(registry: Subcommand.Registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName(this.name)
				.setDescription(this.description)
				.setDMPermission(false)
				.setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
				.addSubcommand((create) => {
					create
						.setName('create')
						.setDescription('Starts a new poll in this channel')
						.addStringOption((question) =>
							question.setName('question').setDescription('The question of the poll').setRequired(true),
						)
						.addStringOption((endsAfter) =>
							endsAfter
								.setName('ends_after')
								.setDescription('The duration of the poll (1 minute, 1 hour, etc')
								.setRequired(true),
						);

					for (let i = 1; i < 9; i++) {
						create.addStringOption((option) =>
							option
								.setName(`option_${i}`)
								.setDescription('An option the users can choose from')
								.setRequired(i === 1 || i === 2),
						);
					}

					return create;
				}),
		);
	}

	private _generatePollComponents(poll: Poll) {
		const whatsMySelectionButton = new MessageButton()
			.setCustomId(`poll.${poll.id}.my_option`)
			.setLabel('Check my selection')
			.setEmoji('ℹ️')
			.setStyle(Constants.MessageButtonStyles.PRIMARY);

		const removeMySelectionButton = new MessageButton()
			.setCustomId(`poll.${poll.id}.remove_selection`)
			.setLabel('Remove my selection')
			.setEmoji('🗑️')
			.setStyle(Constants.MessageButtonStyles.DANGER);

		const specialActionsRow = new MessageActionRow().setComponents([whatsMySelectionButton, removeMySelectionButton]);
		const optionRows = [];
		let emojiIndex = 1;

		const optionChunks = chunk(poll.options, 4);

		for (const optionChunk of optionChunks) {
			const row = new MessageActionRow();

			for (const option of optionChunk) {
				const button = new MessageButton()
					.setCustomId(`poll.${poll.id}.select_${emojiIndex - 1}`)
					.setLabel(trimPretty(option, 78))
					.setStyle(Constants.MessageButtonStyles.SUCCESS)
					.setEmoji(emojiMap[emojiIndex++ as keyof typeof emojiMap]);

				row.addComponents(button);
			}

			optionRows.push(row);
		}

		return [...optionRows, specialActionsRow];
	}
}

const emojiMap = {
	1: '1️⃣',
	2: '2️⃣',
	3: '3️⃣',
	4: '4️⃣',
	5: '5️⃣',
	6: '6️⃣',
	7: '7️⃣',
	8: '8️⃣',
};
