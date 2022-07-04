import { ApplyOptions } from '@sapphire/decorators';
import { Events, Listener } from '@sapphire/framework';
import { Time } from '@sapphire/time-utilities';
import type { Message } from 'discord.js';
import { setTimeout } from 'node:timers/promises';

@ApplyOptions<Listener.Options>({
	event: Events.MessageCreate,
})
export class MessagesWithMedia extends Listener {
	public async run(message: Message) {
		// Ignore bot messages...same with webhooks
		if (message.author.bot || message.webhookId) {
			return;
		}

		const isMessageOnlyChannelEnabled = await this.container.prisma.messageOnlyChannel.findFirst({
			where: { channel_id: message.channelId },
		});

		if (!isMessageOnlyChannelEnabled) {
			return;
		}

		// If the message has attachments, we're good
		if (message.attachments.size !== 0) {
			return;
		}

		// Delete the message if it doesn't have any media
		if (message.deletable) {
			await message.delete();
		}

		const reply = await message.channel.send(
			`${message.author}, sorry, but this channel is for media only, text messages are not allowed!`,
		);

		await setTimeout(Time.Second * 10);

		// Delete message even if someone else deleted it
		await reply.delete().catch(() => null);
	}
}
