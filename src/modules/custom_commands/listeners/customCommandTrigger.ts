import { Buffer } from 'node:buffer';
import { ApplyOptions } from '@sapphire/decorators';
import { Events, Listener } from '@sapphire/framework';
import { AttachmentBuilder, type Message } from 'discord.js';
import { LogPrefix } from '../../../lib/utils/logPrefix.js';
import { hasCustomCommandName } from '../customCommandCache.js';
import {
	CUSTOM_COMMAND_PREFIX,
	isRateLimited,
	isValidCommandName,
	normalizeCommandName,
} from '../customCommandUtils.js';

@ApplyOptions<Listener.Options>({
	event: Events.MessageCreate,
})
export class CustomCommandTrigger extends Listener {
	public async run(message: Message) {
		// Ignore bots, webhooks and DMs.
		if (message.author.bot || message.webhookId || !message.inGuild()) {
			return;
		}

		if (!message.content.startsWith(CUSTOM_COMMAND_PREFIX)) {
			return;
		}

		if (!message.channel.isSendable()) {
			return;
		}

		// First token after the prefix, e.g. "!cat extra" -> "cat".
		const firstToken = message.content.slice(CUSTOM_COMMAND_PREFIX.length).split(/\s+/, 1)[0] ?? '';
		const name = normalizeCommandName(`${CUSTOM_COMMAND_PREFIX}${firstToken}`);

		if (!isValidCommandName(name)) {
			return;
		}

		// Fast bail: if no clan in this guild has a command with this name, do nothing (no DB hit).
		if (!hasCustomCommandName(message.guildId, name)) {
			return;
		}

		// Anti-spam: throttle how often a user can fire custom commands.
		if (isRateLimited(message.guildId, message.author.id)) {
			return;
		}

		// Which clans is the author a member of?
		const memberships = await this.container.prisma.clanMember.findMany({
			where: { clanGuildId: message.guildId, userId: message.author.id },
			select: { clanCustomRoleId: true },
		});

		// Not in any clan -> silently ignore (the perk is clan-only).
		if (memberships.length === 0) {
			return;
		}

		// Only match a command belonging to a clan the author actually belongs to.
		const command = await this.container.prisma.customCommand.findFirst({
			where: {
				guildId: message.guildId,
				name,
				clanCustomRoleId: { in: memberships.map((membership) => membership.clanCustomRoleId) },
			},
		});

		if (!command) {
			return;
		}

		const content = [command.text, command.mediaUrl].filter(Boolean).join('\n') || undefined;
		const files =
			command.mediaData ?
				[new AttachmentBuilder(Buffer.from(command.mediaData), { name: command.mediaName ?? 'media' })]
			:	[];

		const sent = await message.channel
			.send({
				content,
				files,
				// Command output is author-defined text; never let it ping anyone.
				allowedMentions: { parse: [] },
			})
			.catch(() => null);

		if (!sent) {
			return;
		}

		// Record the usage so moderators can audit it via the "Show Command Info" context menu.
		await this.container.prisma.customCommandUsage
			.create({
				data: {
					guildId: message.guildId,
					clanCustomRoleId: command.clanCustomRoleId,
					name: command.name,
					usedBy: message.author.id,
					channelId: message.channelId,
					messageId: sent.id,
				},
			})
			.catch((error: unknown) => {
				this.container.logger.warn(`${LogPrefix.CUSTOM_COMMAND} Failed to log custom command usage`, {
					error: String(error),
				});
			});
	}
}
