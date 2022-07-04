import { ChatInputCommandDeniedPayload, Listener } from '@sapphire/framework';
import type { UserError } from '../lib/extensions/UserError.js';
import { createInfoEmbed } from '../lib/utils/createInfoEmbed.js';

export default class extends Listener {
	public async run(error: Error | UserError, context: ChatInputCommandDeniedPayload) {
		if (context.interaction.replied) {
			await context.interaction.followUp({ ephemeral: true, embeds: [createInfoEmbed(error.message)] });
		} else {
			await context.interaction.reply({ ephemeral: true, embeds: [createInfoEmbed(error.message)] });
		}
		if (!(error as UserError).isArgumentError) this.container.logger.error(error.stack ?? (error.message || error));
	}
}
