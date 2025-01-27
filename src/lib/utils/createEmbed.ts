import { container } from '@sapphire/framework';
import { EmbedBuilder } from 'discord.js';

export function createEmbed(message: string | null) {
	return new EmbedBuilder()
		.setTitle(container.client.user!.username)
		.setDescription(message)
		.setTimestamp()
		.setFooter({
			text: container.client.user!.username,
			iconURL: container.client.user!.displayAvatarURL({ size: 128 }),
		});
}

export function createInfoEmbed(message: string | null) {
	return createEmbed(message).setColor(0x8ed1);
}

export function createErrorEmbed(message: string | null) {
	return createEmbed(message).setColor(0xd14700);
}
