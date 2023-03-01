import { ApplyOptions } from '@sapphire/decorators';
import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import { ButtonInteraction, EmbedBuilder, Message } from 'discord.js';
import { getMemberFromInteraction } from '../lib/utils.js';

@ApplyOptions<InteractionHandler.Options>({
	interactionHandlerType: InteractionHandlerTypes.Button,
})
export class ButtonHandler extends InteractionHandler {
	public override parse(interaction: ButtonInteraction) {
		const { customId } = interaction;

		// If our id format isn't followed, it's not a button we should handle
		if (!customId.startsWith('votekick')) {
			return this.none();
		}

		// ID format: votekick.<action>.<userId>.<voiceChannelId>
		const [, action, userId, voiceChannelId] = customId.split('.') as [
			_: string,
			action: 'yes' | 'no',
			userId: string,
			voiceChannelId: string,
		];

		return this.some({
			action,
			userId,
			voiceChannelId,
		});
	}

	public override async run(
		interaction: ButtonInteraction,
		{ action, userId, voiceChannelId }: InteractionHandler.ParseResult<this>,
	) {
		const { user: userWhoInteractedWithButton, message } = interaction;
		const originalMessage = message as Message;
		const member = (await getMemberFromInteraction(interaction))!;

		// Find vote in db
		const previousVote = await this.container.prisma.voteKick.findFirst({
			where: { user_to_kick: userId, voice_channel_id: voiceChannelId },
		});

		// If it's not present, the vote was concluded already
		if (!previousVote) {
			return interaction.reply({
				ephemeral: true,
				embeds: [new EmbedBuilder().setColor('Red').setDescription("Couldn't find a vote kick for that message!")],
			});
		}

		if (member.voice.channelId !== voiceChannelId) {
			return interaction.reply({
				ephemeral: true,
				embeds: [
					new EmbedBuilder()
						.setColor('Red')
						.setDescription("You cannot vote for a member with whom you're not sharing the same voice channel!"),
				],
			});
		}

		// Check if the voter casted the same vote
		if (
			(action === 'yes' && previousVote.voters_agreeing_with_kick.includes(userWhoInteractedWithButton.id)) ||
			(action === 'no' && previousVote.voters_disagreeing_with_kick.includes(userWhoInteractedWithButton.id))
		) {
			return interaction.reply({
				ephemeral: true,
				embeds: [new EmbedBuilder().setColor('Red').setDescription('You cannot cast the same vote!')],
			});
		}

		// Field 0 is voters who said yes
		// Field 1 is voters who said no
		const updatedMessageEmbed = EmbedBuilder.from(originalMessage.embeds[0]);

		const keyToUpdate = action === 'yes' ? 'voters_agreeing_with_kick' : 'voters_disagreeing_with_kick';
		const keyToRemoveFrom = action === 'yes' ? 'voters_disagreeing_with_kick' : 'voters_agreeing_with_kick';

		// Remove the user's old vote if necessary
		await this.container.prisma.$queryRawUnsafe<ReturnOfRawQuery[]>(
			`update vote_kick set ${keyToRemoveFrom} = array_remove(${keyToRemoveFrom}, $1);`,
			userWhoInteractedWithButton.id,
		);

		// Update the db with the new data
		const currentResults = await this.container.prisma.voteKick.update({
			where: { id: previousVote.id },
			data: { [keyToUpdate]: { push: userWhoInteractedWithButton.id } },
		});

		updatedMessageEmbed.setFields(
			{
				name: 'Members agreeing with vote',
				value: String(currentResults.voters_agreeing_with_kick.length),
				inline: true,
			},
			{
				name: 'Members disagreeing with vote',
				value: String(currentResults.voters_disagreeing_with_kick.length),
				inline: true,
			},
		);

		// If everyone voted, let the vote process
		if (
			currentResults.voters_agreeing_with_kick.length + currentResults.voters_disagreeing_with_kick.length >=
			member.voice.channel!.members.size
		) {
			// Find the scheduled task and run it to get the result
			const result = await this.container.client.schedule.queue
				.find((entity) => entity.data && JSON.parse(entity.data).voteId === previousVote.id)
				?.run();

			// If the task ran, handle its result
			if (result) {
				await this.container.client.schedule['handleResponses']([result]);
			}
		} else {
			// Update original message
			await interaction.update({
				content: originalMessage.content,
				embeds: [updatedMessageEmbed],
				components: originalMessage.components,
			});
		}

		// Let the user know we've recorded their vote
		return interaction.followUp({
			ephemeral: true,
			embeds: [new EmbedBuilder().setColor('Green').setDescription('Your vote was casted successfully')],
		});
	}
}

interface ReturnOfRawQuery {
	updated: string[];
}
