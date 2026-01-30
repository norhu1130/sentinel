import { type ListenerErrorPayload, Listener } from '@sapphire/framework';
import * as Sentry from '@sentry/node';

export class ListenerErrorListener extends Listener {
	public run(error: Error, context: ListenerErrorPayload) {
		this.container.logger.error(`Listener error in ${context.piece.name}:`, error);
		Sentry.captureException(error, {
			extra: {
				listener: context.piece.name,
			},
		});
	}
}
