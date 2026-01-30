import { ApplyOptions } from '@sapphire/decorators';
import { Listener } from '@sapphire/framework';
import * as Sentry from '@sentry/node';
import { red } from 'colorette';

@ApplyOptions<Listener.Options>({ event: 'wtf' })
export class WtfListener extends Listener {
	public run(message: Error | string) {
		this.container.logger.warn(red('Encountered unexpected error'), message);

		if (message instanceof Error) {
			Sentry.captureException(message);
		} else {
			Sentry.captureMessage(message, 'error');
		}
	}
}
