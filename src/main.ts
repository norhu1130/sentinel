import process from 'node:process';
import { inspect } from 'node:util';
import '@sapphire/plugin-logger/register';
import { ApplicationCommandRegistries, LogLevel, RegisterBehavior } from '@sapphire/framework';
import { Time } from '@sapphire/time-utilities';
import * as Sentry from '@sentry/node';
import { createColors } from 'colorette';
import { GuildMember, type User } from 'discord.js';
import { ActivityType, IntentsBitField, Options, Partials } from 'discord.js';
import { UtilsBot } from './lib/UtilsBot.js';

if (process.env.SENTRY_DSN) {
	Sentry.init({
		dsn: process.env.SENTRY_DSN,
		environment: process.env.NODE_ENV ?? 'development',
		tracesSampleRate: 0,
	});
}

process.on('uncaughtException', (error) => {
	console.error('Uncaught Exception:', error);
	Sentry.captureException(error);
});

process.on('unhandledRejection', (reason) => {
	console.error('Unhandled Rejection:', reason);
	if (reason instanceof Error) {
		Sentry.captureException(reason);
	} else {
		Sentry.captureMessage(String(reason), 'error');
	}
});

ApplicationCommandRegistries.setDefaultBehaviorWhenNotIdentical(RegisterBehavior.Overwrite);

inspect.defaultOptions.depth = 2;
const colorette = createColors({ useColor: true });

function checkUserOrMember(userOrMember: GuildMember | User) {
	if (userOrMember.id !== userOrMember.client.user!.id) {
		if (userOrMember instanceof GuildMember) {
			return userOrMember.voice.channelId !== null;
		}

		return false;
	}

	return true;
}

const client = new UtilsBot({
	presence: {
		activities: [
			{
				name: 'with tools!',
				type: ActivityType.Playing,
			},
		],
	},
	intents: new IntentsBitField([
		IntentsBitField.Flags.Guilds,
		IntentsBitField.Flags.GuildMembers,
		IntentsBitField.Flags.GuildModeration,
		IntentsBitField.Flags.GuildMessages,
		IntentsBitField.Flags.GuildVoiceStates,
		IntentsBitField.Flags.DirectMessages,
		IntentsBitField.Flags.MessageContent,
	]),
	partials: [Partials.Channel, Partials.Message, Partials.GuildMember],
	caseInsensitiveCommands: true,
	loadMessageCommandListeners: true,
	logger: {
		depth: 2,
		level: Reflect.has(process.env, 'PM2_HOME') ? LogLevel.Info : LogLevel.Debug,
	},
	loadDefaultErrorListeners: false,
	makeCache: Options.cacheWithLimits({
		MessageManager: {
			maxSize: 50,
		},
		UserManager: {
			maxSize: 100,
			keepOverLimit: (user) => user.id === user.client.user!.id,
		},
		GuildMemberManager: {
			maxSize: 999_999_999_999_999,
		},
		// Useless props for the bot
		GuildEmojiManager: { maxSize: 0 },
		GuildStickerManager: { maxSize: 0 },
	}),
	sweepers: {
		users: {
			interval: Time.Minute * 15,
			// Sweep all users except the bot user
			filter: () => checkUserOrMember,
		},
		messages: {
			interval: Time.Minute * 5,
			lifetime: Time.Minute * 15,
		},
	},
});

try {
	await client.login();
} catch (error) {
	client.logger.error(colorette.red('Failed to launch the bot:'), error);
	Sentry.captureException(error);
	await client.destroy();
}
