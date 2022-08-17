import { time } from '@discordjs/builders';
import type { Poll, PollAnswer } from '@prisma/client';

export function generatePollEmbedDescription(
	poll: Poll & {
		answers: PollAnswer[];
	},
	ended: boolean,
) {
	const entries = [];

	for (let i = 0; i < poll.options.length; i++) {
		const options = poll.answers.filter((answer) => answer.option_index === i);

		const percentage = Math.trunc((options.length / poll.answers.length) * 100);

		entries.push(`${poll.options[i]}: **${options.length}** (${Number.isNaN(percentage) ? 0 : percentage}%)`);
	}

	entries.push(
		'',
		ended
			? `> Poll started on **${time(poll.created_at)}**, and ended on **${time(poll.ends_at)}**`
			: `> Poll ends in **${time(poll.ends_at, 'R')}**`,
	);

	return entries.join('\n');
}
