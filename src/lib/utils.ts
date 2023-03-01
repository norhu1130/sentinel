import { container } from '@sapphire/framework';
import { DurationFormatter, Timestamp } from '@sapphire/time-utilities';
import { GatewayMessageCreateDispatchData, Interaction, Message, User } from 'discord.js';

export const timeFormat = new Timestamp('YYYY-MM-DD [at] HH:mm:ss [UTC]');

export const durationFormat = new DurationFormatter();

export function toReadableUser(user: User) {
	return `${user.tag} (${user.id})` as const;
}

export async function fetchReadableUser(id: string) {
	const user = await container.client.users.fetch(id);
	return toReadableUser(user);
}

export async function getMemberFromInteraction(interaction: Interaction) {
	if (!interaction.guildId) return null;

	const guild = interaction.guild!;
	const member = interaction.member!;

	return guild.members.fetch({ user: member.user.id });
}

export function getMessageUrlFromInteractionResponse(message: Message | GatewayMessageCreateDispatchData) {
	if (message instanceof Message) {
		return message.url;
	}

	return `https://discord.com/channels/${message.guild_id ?? '@me'}/${message.channel_id}/${message.id}`;
}
