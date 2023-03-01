// ID format: poll.id.{my_option|remove_selection|select_{id}}

import { ApplyOptions } from '@sapphire/decorators';
import { InteractionHandler, InteractionHandlerTypes, Result } from '@sapphire/framework';
import { ButtonInteraction, EmbedBuilder, Message } from 'discord.js';
import { createInfoEmbed } from '../lib/utils/createInfoEmbed.js';
import { generatePollEmbedDescription } from '../lib/utils/polls/generatePollEmbed.js';

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

		const existingAnswer = await this.container.prisma.pollAnswer.findFirst({
			where: { poll_id: poll.id, user_id: interaction.user.id },
		});

		switch (action) {
			case 'my_option': {
				if (!existingAnswer) {
					return interaction.reply({
						ephemeral: true,
						embeds: [createInfoEmbed(`You haven't selected an answer yet!`)],
					});
				}

				return interaction.reply({
					embeds: [
						createInfoEmbed(
							`You selected option number **${existingAnswer.option_index + 1}**: ${
								poll.options[existingAnswer.option_index]
							}`,
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

					await this.updatePollMessage(interaction, poll.id);

					await interaction.followUp({
						ephemeral: true,
						embeds: [
							createInfoEmbed(
								`Your vote for this poll has been removed.\n\nAs a reminder, you voted for option **${
									answer.option_index + 1
								}**: ${poll.options[answer.option_index]}`,
							),
						],
					});

					return;
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
				if (existingAnswer) {
					// Same vote, no need to do anything
					if (existingAnswer.option_index === numericIndex) {
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

					await this.updatePollMessage(interaction, poll.id);

					await interaction.followUp({
						embeds: [
							createInfoEmbed(
								`You changed your vote from option number **${existingAnswer.option_index + 1}** to option number **${
									numericIndex + 1
								}**: ${poll.options[numericIndex]}`,
							),
						],
						ephemeral: true,
					});

					return;
				}

				// User has not voted before, create
				await this.container.prisma.pollAnswer.create({
					data: {
						poll_id: poll.id,
						user_id: interaction.user.id,
						option_index: numericIndex,
					},
				});

				await this.updatePollMessage(interaction, poll.id);

				return interaction.followUp({
					embeds: [
						createInfoEmbed(`You voted for option number **${numericIndex + 1}**: ${poll.options[numericIndex]}`),
					],
					ephemeral: true,
				});
			}
		}
	}

	private async updatePollMessage(interaction: ButtonInteraction, pollId: string) {
		const poll = await this.container.prisma.poll.findFirst({ where: { id: pollId }, include: { answers: true } });

		if (!poll) {
			return;
		}

		const newDescription = generatePollEmbedDescription(poll, false);

		const originalMessage = (
			await Result.fromAsync(() => interaction.channel!.messages.fetch(interaction.message.id) as Promise<Message>)
		).unwrapOr(null);

		if (originalMessage) {
			const newEmbed = EmbedBuilder.from(originalMessage.embeds[0]);
			newEmbed.setDescription(newDescription);

			await interaction.update({
				embeds: [newEmbed],
			});
		}
	}
}
