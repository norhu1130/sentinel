import { ApplyOptions } from '@sapphire/decorators';
import { Listener, ListenerOptions } from '@sapphire/framework';
import { cyanBright, green, magenta } from 'colorette';

@ApplyOptions<ListenerOptions>({
	once: true,
	event: 'ready',
})
export class ReadyEvent extends Listener {
	public async run() {
		const { client } = this.container;
		const { user, logger } = client;

		logger.info(magenta(`Logged in as ${cyanBright(user!.tag)} (${green(user!.id)})`));

		try {
			await client.schedule.init();
		} catch (error) {
			client.emit('wtf', error);
		}
	}
}
