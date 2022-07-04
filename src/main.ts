import { ApplicationCommandRegistries, LogLevel, RegisterBehavior } from '@sapphire/framework';
import '@sapphire/plugin-logger/register';
import { createColors } from 'colorette';
import { Intents } from 'discord.js';
import { inspect } from 'util';
import { UtilsBot } from './lib/UtilsBot.js';

ApplicationCommandRegistries.setDefaultBehaviorWhenNotIdentical(RegisterBehavior.Overwrite);

inspect.defaultOptions.depth = 2;
const colorette = createColors({ useColor: true });

const client = new UtilsBot({
	presence: {
		activities: [
			{
				name: 'with tools!',
				type: 'PLAYING',
			},
		],
	},
	restTimeOffset: 0,
	intents: new Intents([
		Intents.FLAGS.GUILDS,
		Intents.FLAGS.GUILD_MEMBERS,
		Intents.FLAGS.GUILD_BANS,
		Intents.FLAGS.GUILD_MESSAGES,
	]),
	caseInsensitiveCommands: true,
	logger: {
		depth: 2,
		level: Reflect.has(process.env, 'PM2_HOME') ? LogLevel.Info : LogLevel.Debug,
	},
	loadDefaultErrorListeners: false,
});

try {
	await client.login();
} catch (error) {
	client.logger.error(colorette.red('Failed to launch the bot:'), error);
	client.destroy();
}
