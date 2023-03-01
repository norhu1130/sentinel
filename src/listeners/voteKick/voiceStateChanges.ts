import { ApplyOptions } from '@sapphire/decorators';
import { Listener, ListenerOptions } from '@sapphire/framework';
import { EmbedBuilder, TextChannel, VoiceState } from 'discord.js';
import memoize from 'lodash.memoize';
import { setTimeout as sleep } from 'timers/promises';

@ApplyOptions<ListenerOptions>({ event: 'voiceStateUpdate' })
export default class extends Listener {
	public async run(oldState: VoiceState, newState: VoiceState) {
		// If the member wasn't in a voice channel before, ignore
		if (!oldState.channelId) return;
		// If the channels match, ignore
		if (oldState.channelId === newState.channelId) return;

		// From this point on, either the member left the voice channel, or they moved to another one
		// Just for safety, we're waiting ~250ms in case the member gets kicked out of the voice channel
		await sleep(250);

		// Fetch any votes in the old voice channel that may contain the member's vote
		const votes = await this.container.prisma.voteKick.findMany({
			where: {
				voice_channel_id: oldState.channelId,
				OR: [
					{
						voters_agreeing_with_kick: { has: oldState.id },
					},
					{
						voters_disagreeing_with_kick: { has: oldState.id },
					},
				],
			},
		});

		if (votes.length) {
			const results = (
				await this.container.prisma.$transaction(
					votes.map(() =>
						this.container.prisma.$queryRawUnsafe<
							[{ voters_agreeing_with_kick: string[]; voters_disagreeing_with_kick: string[]; message_url: string }]
						>(
							`update vote_kick set voters_agreeing_with_kick = array_remove(voters_agreeing_with_kick, $1), voters_disagreeing_with_kick = array_remove(voters_disagreeing_with_kick, $1) returning voters_agreeing_with_kick, voters_disagreeing_with_kick, message_url;`,
							oldState.id,
						),
					),
				)
			).flat(2);

			for (const { message_url, voters_disagreeing_with_kick, voters_agreeing_with_kick } of results) {
				const { channelId, messageId } = parseMessageUrl(message_url);

				const channel = this.container.client.channels.resolve(channelId) as TextChannel;
				const message = await channel.messages.fetch(messageId);

				await message.edit({
					embeds: [
						EmbedBuilder.from(message.embeds[0]).setFields(
							{ name: 'Members agreeing with vote', value: String(voters_agreeing_with_kick.length), inline: true },
							{
								name: 'Members disagreeing with vote',
								value: String(voters_disagreeing_with_kick.length),
								inline: true,
							},
						),
					],
				});
			}
		}
	}
}

// for some stupid reason I cannot export it from the other file >.>
const parseMessageUrl = memoize(function parseMessageUrl(url: string) {
	const [_https, _, _domain, _path, guildId, channelId, messageId] = url.split('/');

	return { guildId, channelId, messageId };
});
