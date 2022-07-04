import { container } from '@sapphire/framework';
import { MessageEmbed } from 'discord.js';

export function createInfoEmbed(message: string) {
	return new MessageEmbed()
		.setTitle(container.client.user!.username)
		.setDescription(message)
		.setTimestamp()
		.setColor(0x8ed1)
		.setFooter({
			text: container.client.user!.username,
			iconURL: container.client.user!.displayAvatarURL({ size: 128 }),
		});
}
