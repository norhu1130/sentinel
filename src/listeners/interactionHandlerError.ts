import { type InteractionHandlerError, Listener } from '@sapphire/framework';
import * as Sentry from '@sentry/node';
import { createInfoEmbed } from '../lib/utils/createEmbed.js';

export class InteractionHandlerErrorListener extends Listener {
	public async run(error: Error, context: InteractionHandlerError) {
		this.container.logger.error(`Interaction handler error in ${context.handler.name}:`, error);
		Sentry.captureException(error, {
			extra: {
				handler: context.handler.name,
				userId: context.interaction.user.id,
				guildId: context.interaction.guildId,
			},
		});

		if (context.interaction.isRepliable()) {
			const content = {
				embeds: [createInfoEmbed('An error occurred while processing this interaction.')],
				ephemeral: true,
			};
			if (context.interaction.replied || context.interaction.deferred) {
				await context.interaction.followUp(content).catch(() => null);
			} else {
				await context.interaction.reply(content).catch(() => null);
			}
		}
	}
}
