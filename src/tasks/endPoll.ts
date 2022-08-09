import { time } from '@discordjs/builders';
import { Result } from '@sapphire/framework';
import type { GuildTextBasedChannel } from 'discord.js';
import { Task, TaskRunData } from '../lib/schedule/tasks/Task.js';
import { fetchReadableUser } from '../lib/utils.js';
import { createInfoEmbed } from '../lib/utils/createInfoEmbed.js';

export class EndPoll extends Task {
	public async run(data: TaskRunData) {
		const { pollId } = JSON.parse(data.data!) as { pollId: string };

		const poll = await this.container.prisma.poll.findFirst({
			where: { id: pollId },
			include: {
				answers: true,
				_count: true,
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

		const newEmbedDescription = [
			`**The poll ended!** It was started on ${time(poll.created_at)}.`,
			'',
			`${poll.question}`,
			'',
			'**Results:**',
		];

		for (let i = 0; i < poll.options.length; i++) {
			const answersOfThisOption = poll.answers.filter((answer) => answer.option_index === i);

			const percentage = Math.trunc((answersOfThisOption.length / poll._count.answers) * 100);

			newEmbedDescription.push(
				`> Option ${i + 1} received **${
					answersOfThisOption.length === 1 ? '1 vote' : `${answersOfThisOption.length} votes`
				}** (${Number.isNaN(percentage) ? 0 : percentage}%).`,
			);
		}

		newEmbedDescription.push(
			'',
			`> In total, there ${
				poll._count.answers === 1 ? `was **${poll._count.answers}** vote` : `were **${poll._count.answers}** votes`
			}.`,
		);

		const newEmbed = createInfoEmbed(newEmbedDescription.join('\n'))
			.setFields(
				poll.options.map((option, index) => ({
					name: `Option ${index + 1}`,
					value: option,
					inline: true,
				})),
			)
			.setFooter({ text: `Poll started by ${await fetchReadableUser(poll.author_id)}` });

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
