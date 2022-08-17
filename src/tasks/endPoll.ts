import { Result } from '@sapphire/framework';
import type { GuildTextBasedChannel } from 'discord.js';
import { Task, TaskRunData } from '../lib/schedule/tasks/Task.js';
import { fetchReadableUser } from '../lib/utils.js';
import { createInfoEmbed } from '../lib/utils/createInfoEmbed.js';
import { generatePollEmbedDescription } from '../lib/utils/polls/generatePollEmbed.js';

export class EndPoll extends Task {
	public async run(data: TaskRunData) {
		const { pollId } = JSON.parse(data.data!) as { pollId: string };

		const poll = await this.container.prisma.poll.findFirst({
			where: { id: pollId },
			include: {
				answers: true,
			},
		});

		if (!poll) {
			this.container.logger.warn(`Poll not found: ${pollId} but was supposed to be ended now`);
			return null;
		}

		const channel = (await this.container.client.channels.fetch(poll.channel_id)) as GuildTextBasedChannel;
		const messageFetchResult = await Result.fromAsync(() => channel.messages.fetch(poll.message_id));

		if (messageFetchResult.isErr()) {
			this.container.logger.warn(`Failed to find message for poll ${pollId} with message id ${poll.message_id}`);
			return null;
		}

		const message = messageFetchResult.unwrap();

		const newEmbedDescription = [`**The poll ended!**`, '', '**Results:**', generatePollEmbedDescription(poll, true)];

		newEmbedDescription.push(
			`> In total, there ${
				poll.answers.length === 1 ? `was **${poll.answers.length}** vote` : `were **${poll.answers.length}** votes`
			}.`,
		);

		const newEmbed = createInfoEmbed(newEmbedDescription.join('\n'))
			.setTitle(poll.question)
			.setFooter({
				text: `Poll started by ${await fetchReadableUser(poll.author_id)}`,
			});

		await message.edit({
			embeds: [newEmbed],
			components: [],
		});

		await this.container.prisma.poll.update({
			where: { id: pollId },
			data: { ended: true },
		});

		return null;
	}
}
