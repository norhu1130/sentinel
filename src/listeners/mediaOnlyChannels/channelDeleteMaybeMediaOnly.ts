import { ApplyOptions } from '@sapphire/decorators';
import { Events, Listener } from '@sapphire/framework';
import type { GuildChannel } from 'discord.js';

@ApplyOptions<Listener.Options>({
	event: Events.ChannelDelete,
})
export class ChannelDeleteMaybeMediaOnly extends Listener {
	public async run(channel: GuildChannel) {
		await this.container.prisma.messageOnlyChannel.delete({
			where: { channel_id: channel.id },
		});
	}
}
