import { time } from '@discordjs/builders';
import type { User, VoteKick } from '@prisma/client';
import { Time } from '@sapphire/time-utilities';
import { GuildTextBasedChannel, MessageEmbed } from 'discord.js';
import memoize from 'lodash.memoize';
import { Task, TaskRunData } from '../../lib/schedule/tasks/Task.js';
import { fetchReadableUser } from '../../lib/utils.js';

export interface VoteInput {
	voteId: string;
	expectedNumberOfVotesToDecideOutcome: number;
}

export enum FinalAction {
	NotEnoughVotes,
	Kick,
	Ignore,
}

const actionToResult = {
	[FinalAction.NotEnoughVotes]: "no actions will be taken, as the vote didn't have a majority of the votes on one side",
	[FinalAction.Kick]: 'the user was kicked and timed out from joining voice channels',
	[FinalAction.Ignore]: "the user won't be kicked out as the majority voted against it",
};

const kickAmountToDelay = {
	// First kick
	1: (now: number) => new Date(now + Time.Minute * 5),
	// Second kick
	2: (now: number) => new Date(now + Time.Minute * 25),
	// Last kick
	3: (_now: number) => null,
};

export class HandleVoteResult extends Task {
	public async run(payload: TaskRunData) {
		const data = JSON.parse(payload.data!) as VoteInput;

		// Fetch vote
		const vote = await this.container.prisma.voteKick.findFirst({ where: { id: data.voteId } });

		if (!vote) {
			this.container.logger.warn(`Failed to find vote for handling results... ${JSON.stringify(data)}`);
			return null;
		}

		// Delete the entry from the database since we're done with it
		await this.container.prisma.voteKick.delete({ where: { id: vote.id } });

		// Check results
		let finalAction = FinalAction.NotEnoughVotes;

		// If enough votes were in favor of kicking the user, do it
		if (vote.voters_agreeing_with_kick.length >= data.expectedNumberOfVotesToDecideOutcome) {
			finalAction = FinalAction.Kick;
			// Else if more people voted against kicking the user, don't do anything
		} else if (vote.voters_disagreeing_with_kick.length >= data.expectedNumberOfVotesToDecideOutcome) {
			finalAction = FinalAction.Ignore;
		}

		// Update message
		await this.updateMessage(vote, finalAction);

		// Kick the user from the voice channel, add the role to them, upsert user entry with reset timer
		if (finalAction === FinalAction.Kick) {
			const previousData = await this.container.prisma.user.findFirst({ where: { id: vote.user_to_kick } });
			const now = Date.now();
			const resetKicksAt = new Date(now + Time.Hour * 6);

			// Create or update the user profile
			const user = await this.container.prisma.user.upsert({
				create: {
					id: vote.user_to_kick,
					kicks: 1,
					remove_role_at: kickAmountToDelay[1](now),
					reset_kicks_at: resetKicksAt,
				},
				update: {
					kicks: {
						increment: 1,
					},
					remove_role_at: kickAmountToDelay[((previousData?.kicks ?? 0) + 1) as 1 | 2 | 3](now),
					reset_kicks_at: resetKicksAt,
				},
				where: { id: vote.user_to_kick },
			});

			// Add role if present and kick from voice channel
			await this.addTimeoutRoleToMemberAndKickFromVoiceChannel(vote, user);
		}

		// Log to modlog
		await this.logToModLog(vote, finalAction);

		return null;
	}

	private async updateMessage(vote: VoteKick, action: FinalAction) {
		const { channelId, messageId } = parseMessageUrl(vote.message_url);

		const channel = this.container.client.channels.cache.get(channelId);
		if (!channel?.isText()) return;

		const originalMessage = await channel.messages.fetch(messageId);

		await originalMessage.edit({
			embeds: [
				new MessageEmbed(originalMessage.embeds[0])
					.setColor(action === FinalAction.Ignore ? 'YELLOW' : action === FinalAction.Kick ? 'GREEN' : 'RED')
					.setDescription(
						[
							`The vote to kick **${await fetchReadableUser(vote.user_to_kick)}** ended!`,
							'',
							`The result is: **${actionToResult[action]}**!`,
						].join('\n'),
					)
					.setFields(
						{ name: 'Members agreeing with vote', value: String(vote.voters_agreeing_with_kick.length), inline: true },
						{
							name: 'Members disagreeing with vote',
							value: String(vote.voters_disagreeing_with_kick.length),
							inline: true,
						},
					),
			],
			components: [],
		});
	}

	private async addTimeoutRoleToMemberAndKickFromVoiceChannel(vote: VoteKick, user: User) {
		if (!process.env.BLOCKED_FROM_VOICE_CHANNEL_ROLE_ID) return;

		const { guildId } = parseMessageUrl(vote.message_url);
		const member = await this.container.client.guilds.resolve(guildId)!.members.fetch({ user: vote.user_to_kick });

		// If the member doesn't have the role yet, add it
		if (!member.roles.cache.has(process.env.BLOCKED_FROM_VOICE_CHANNEL_ROLE_ID)) {
			await member.roles.add(
				process.env.BLOCKED_FROM_VOICE_CHANNEL_ROLE_ID,
				'Added role to user due to a vote kick passing',
			);
		}

		// Kick the member from voice
		await member.voice.setChannel(null, 'Kicked member as vote kick passed');

		try {
			const embed = new MessageEmbed().setColor('RED');

			if (user.remove_role_at) {
				embed.setDescription(
					`You have been timed out from voice channels. You will be unmuted at ${time(user.remove_role_at, 'T')}`,
				);
			} else {
				embed.setDescription(
					'You have been timed out permanently from voice channels. Please contact ModMail to appeal this.',
				);
			}

			await member.send({ embeds: [embed] });
		} catch {
			// Can't DM them, of well
		}
	}

	private async logToModLog(vote: VoteKick, finalAction: FinalAction) {
		if (!process.env.MODLOG_CHANNEL_ID) return;

		const channel = this.container.client.channels.cache.get(process.env.MODLOG_CHANNEL_ID) as GuildTextBasedChannel;
		const kickedUser = await this.container.client.users.fetch(vote.user_to_kick);

		await channel.send({
			embeds: [
				new MessageEmbed()
					.setColor('BLURPLE')
					.setDescription(
						[
							`Vote started by: **${await fetchReadableUser(vote.started_by)}**`,
							`Vote started for: **${await fetchReadableUser(vote.user_to_kick)}**`,
							// `Total votes: **${
							// 	vote.voters_agreeing_with_kick.length + vote.voters_disagreeing_with_kick.length
							// }**`,
							// `Voters agreeing kick: ${vote.voters_agreeing_with_kick.map((id) => `<@${id}>`).join(', ')}`,
							// `Voters disagreeing kick: ${vote.voters_disagreeing_with_kick.map((id) => `<@${id}>`).join(', ')}`,
							`Action taken: **${FinalAction[finalAction]}**`,
						].join('\n'),
					)
					.setThumbnail(kickedUser.displayAvatarURL({ dynamic: true, size: 256, format: 'png' }))
					.setFooter({ text: 'Started at' })
					.setTimestamp(vote.created_at),
			],
		});
	}
}

const parseMessageUrl = memoize(function parseMessageUrl(url: string) {
	const [_https, _, _domain, _path, guildId, channelId, messageId] = url.split('/');

	return { guildId, channelId, messageId };
});
