// ID format: poll.id.{my_option|remove_selection|select_{id}}

import { ApplyOptions } from '@sapphire/decorators';
import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import type { ButtonInteraction } from 'discord.js';
import { createInfoEmbed } from '../lib/utils/createInfoEmbed.js';

@ApplyOptions<InteractionHandler.Options>({ interactionHandlerType: InteractionHandlerTypes.Button })
export class PollButtonHandler extends InteractionHandler {
	public override async parse(interaction: ButtonInteraction) {
		// Ensure the id starts with 'poll.'
		if (!interaction.customId.startsWith('poll.')) return this.none();

		const split = interaction.customId.split('.');
		// Remove the 'poll.' prefix
		split.shift();

		// Ensure we have two parts left
		if (split.length !== 2) return this.none();

		const poll = await this.container.prisma.poll.findFirst({
			where: { id: split[0] },
			include: { answers: true },
		});

		return this.some({
			poll,
			action: split[1] as `my_option` | `remove_selection` | `select_${number}`,
		});
	}

	public override async run(interaction: ButtonInteraction, { poll, action }: InteractionHandler.ParseResult<this>) {
		if (!poll) {
			return interaction.reply({
				embeds: [createInfoEmbed(`This shouldn't happen! Couldn't find a poll for that button 😳`)],
				ephemeral: true,
			});
		}

		switch (action) {
			case 'my_option': {
				const answer = poll.answers.find((item) => item.user_id === interaction.user.id);

				if (!answer) {
					return interaction.reply({
						ephemeral: true,
						embeds: [createInfoEmbed(`You haven't selected an answer yet!`)],
					});
				}

				return interaction.reply({
					embeds: [
						createInfoEmbed(
							`You selected option number **${answer.option_index + 1}**: ${poll.options[answer.option_index]}`,
						),
					],
					ephemeral: true,
				});
			}
			case 'remove_selection': {
				try {
					const answer = await this.container.prisma.pollAnswer.delete({
						where: { poll_id_user_id: { poll_id: poll.id, user_id: interaction.user.id } },
					});

					return interaction.reply({
						ephemeral: true,
						embeds: [
							createInfoEmbed(
								`Your vote for this poll has been removed.\n\nAs a reminder, you voted for option **${
									answer.option_index + 1
								}**: ${poll.options[answer.option_index]}`,
							),
						],
					});
				} catch {
					return interaction.reply({
						embeds: [createInfoEmbed(`You haven't selected an answer yet! There's no answer to clear 👀`)],
						ephemeral: true,
					});
				}
			}
			default: {
				const [_, index] = action.split('_');

				const numericIndex = Number(index);

				if (Number.isNaN(numericIndex)) {
					this.container.logger.error(
						`[POLL BUTTONS] WTF! For poll ${poll.id}, received interaction with custom id ${interaction.customId} that I cannot process. Yikes and wtf in this order.`,
					);

					return interaction.reply({
						embeds: [
							createInfoEmbed(
								`Something wrong definitely happened and I cannot process the option you want to select...`,
							),
						],
						ephemeral: true,
					});
				}

				// Lets see if the user already voted
				const oldVote = poll.answers.find((answer) => answer.user_id === interaction.user.id);

				if (oldVote) {
					// Same vote, no need to do anything
					if (oldVote.option_index === numericIndex) {
						return interaction.reply({
							embeds: [
								createInfoEmbed(
									`You already voted for option number **${numericIndex + 1}**: ${poll.options[numericIndex]}`,
								),
							],
							ephemeral: true,
						});
					}

					// User has voted before, replace
					await this.container.prisma.pollAnswer.update({
						data: { option_index: numericIndex },
						where: { poll_id_user_id: { poll_id: poll.id, user_id: interaction.user.id } },
					});

					return interaction.reply({
						embeds: [
							createInfoEmbed(
								`You changed your vote from option number **${oldVote.option_index + 1}** to option number **${
									numericIndex + 1
								}**: ${poll.options[numericIndex]}`,
							),
						],
						ephemeral: true,
					});
				}

				// User has not voted before, create
				await this.container.prisma.pollAnswer.create({
					data: {
						poll_id: poll.id,
						user_id: interaction.user.id,
						option_index: numericIndex,
					},
				});

				return interaction.reply({
					embeds: [
						createInfoEmbed(`You voted for option number **${numericIndex + 1}**: ${poll.options[numericIndex]}`),
					],
					ephemeral: true,
				});
			}
		}
	}
}
