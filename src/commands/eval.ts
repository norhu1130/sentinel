import { inspect } from 'node:util';
import type { Args } from '@sapphire/framework';
import { Command } from '@sapphire/framework';
import { Stopwatch } from '@sapphire/stopwatch';
import { Type } from '@sapphire/type';
import { codeBlock, isThenable } from '@sapphire/utilities';
import type { Message, TextChannel } from 'discord.js';

export class ClientCommand extends Command {
	public override async messageRun(message: Message, args: Args) {
		if (message.author.id !== '141288766760288256') {
			return;
		}

		const code = await args.rest('string');
		const { success, result, time, type } = await this.eval(message, code);

		return (message.channel as TextChannel).send(
			(success ? '**Output**:{output}\n**Type**:{type}\n{time}' : '**Error**:{output}\n**Type**:{type}\n{time}')
				.replace('{output}', codeBlock('js', result))
				.replace('{type}', codeBlock('ts', type.toString()))
				.replace('{time}', time),
		);
	}

	// Eval the input
	private async eval(message: Message, code: string) {
		const stopwatch = new Stopwatch();
		let success: boolean | undefined;
		let syncTime: string | undefined;
		let asyncTime: string | undefined;
		let result: unknown | undefined;
		let thenable = false;
		let type: Type | undefined;
		try {
			// @ts-expect-error 6133

			const msg = message;
			// eslint-disable-next-line no-eval
			result = eval(code);
			syncTime = stopwatch.toString();
			type = new Type(result);
			if (isThenable(result)) {
				thenable = true;
				stopwatch.restart();
				result = await (result as Promise<unknown>);
				asyncTime = stopwatch.toString();
			}

			success = true;
		} catch (error) {
			if (!syncTime) syncTime = stopwatch.toString();
			if (thenable && !asyncTime) asyncTime = stopwatch.toString();
			if (!type!) type = new Type(error);
			result = error;
			success = false;
		}

		stopwatch.stop();
		if (typeof result !== 'string') {
			result = result instanceof Error ? result.stack : inspect(result, { depth: 0 });
		}

		return { success, type: type!, time: this.formatTime(syncTime!, asyncTime ?? ''), result: result as string };
	}

	private formatTime(syncTime: string, asyncTime: string) {
		return asyncTime ? `⏱ ${asyncTime}<${syncTime}>` : `⏱ ${syncTime}`;
	}
}
