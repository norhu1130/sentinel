import { type ChatInputCommandErrorPayload, Listener } from '@sapphire/framework';
import * as Sentry from '@sentry/node';
import { MessageFlags } from 'discord-api-types/v10';
import type { UserError } from '../lib/extensions/UserError.js';
import { createInfoEmbed } from '../lib/utils/createEmbed.js';

export default class extends Listener {
	public async run(error: Error | UserError, context: ChatInputCommandErrorPayload) {
		if (context.interaction.replied) {
			await context.interaction.followUp({
				flags: MessageFlags.Ephemeral,
				embeds: [createInfoEmbed(error.message)],
			});
		} else {
			await context.interaction.reply({
				flags: MessageFlags.Ephemeral,
				embeds: [createInfoEmbed(error.message)],
			});
		}

		if (!(error as UserError).isArgumentError) {
			this.container.logger.error(error.stack ?? (error.message || error));
			Sentry.captureException(error, {
				extra: {
					command: context.command.name,
					userId: context.interaction.user.id,
					guildId: context.interaction.guildId,
				},
			});
		}
	}
}
