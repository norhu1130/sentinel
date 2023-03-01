import { PermissionFlagsBits } from 'discord-api-types/v10';
import type { GuildTextBasedChannel, Message } from 'discord.js';
import { Task } from '../lib/schedule/tasks/Task.js';

const indent = ' '.repeat(4);
const header = '[AUTOPIN] ';

export class CheckAutoPins extends Task {
	public async run() {
		const autoPins = await this.container.prisma.autoPin.findMany();

		if (autoPins.length === 0) {
			this.container.logger.info(`${header}No autopins found for processing`);
			return null;
		}

		this.container.logger.info(`${header}Starting processing autopins...`);

		for (const autoPin of autoPins) {
			const channel = (await this.container.client.channels
				.fetch(autoPin.channel_id)
				.catch(() => null)) as GuildTextBasedChannel | null;

			if (!channel) {
				this.container.logger.warn(
					`${header}${indent}Failed to find channel ${autoPin.channel_id} for autopin ${autoPin.id}`,
				);
				continue;
			}

			const me = await channel.guild.members.fetch(this.container.client.user!.id);

			if (!channel.permissionsFor(me).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages], true)) {
				this.container.logger.warn(
					`${header}${indent}I don't have permissions to view channel / send messages in ${channel.name} (${channel.id}) in guild ${channel.guild.name} (${channel.guild.id})`,
				);
				continue;
			}

			let msg: Message | undefined;

			try {
				const lastMessages = await channel.messages.fetch({ limit: 1, cache: false });

				msg = lastMessages.first();
			} catch (err) {
				this.container.logger.warn(
					`${header}${indent}Failed to fetch messages for autopin ${autoPin.id} in channel ${channel.name} (${channel.id}) for guild ${channel.guild.name} (${channel.guild.id})`,
					err,
				);
				continue;
			}

			if ((msg?.id ?? '-0') === autoPin.last_message_id) {
				// Same message as before, update and skip
				this.container.logger.debug(
					`${header}${indent}Skipping autopin ${autoPin.id} as the last message is the autopin one`,
				);

				await this.container.prisma.autoPin.update({
					data: { last_check: new Date() },
					where: { id: autoPin.id },
				});

				continue;
			}

			// Try deleting the message
			if (autoPin.last_message_id) {
				try {
					await channel.messages.delete(autoPin.last_message_id);
				} catch {}
			}

			try {
				const newMessage = await channel.send({
					content: autoPin.content,
					allowedMentions: { parse: [] },
				});

				await this.container.prisma.autoPin.update({
					data: {
						last_message_id: newMessage.id,
						last_check: new Date(),
					},
					where: { id: autoPin.id },
				});

				this.container.logger.info(
					`${header}${indent}Successfully autopinned ${autoPin.id} (new message id: ${newMessage.id}) for channel ${channel.name} (${channel.id}) in guild ${channel.guild.name} (${channel.guild.id})`,
				);
			} catch (err) {
				this.container.logger.error(
					`${header}${indent}Failed to autopin ${autoPin.id} for channel ${channel.name} (${channel.id}) for guild ${channel.guild.name} (${channel.guild.id})`,
					err,
				);
			}
		}

		this.container.logger.info(`${header}Finished processing autopins`);

		return null;
	}
}
