import crypto from 'node:crypto';
import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	type ChatInputCommandInteraction,
	type Message,
	type MessageActionRowComponentBuilder,
	type MessageComponentInteraction,
	type MessageCreateOptions,
	type TextBasedChannel,
	type TextChannel,
	type User,
} from 'discord.js';

type Context = ChatInputCommandInteraction | Message | MessageComponentInteraction | TextBasedChannel | User;

function isContextInteraction(context: Context): context is ChatInputCommandInteraction {
	return 'commandId' in context && Boolean(context.commandId);
}

export async function waitForButtonConfirm(
	context: Context,
	toPost: Omit<MessageCreateOptions, 'flags'> | string,
	options?: WaitForOptions,
): Promise<{ confirmed: boolean; context: Context }> {
	// eslint-disable-next-line no-async-promise-executor
	return new Promise(async (resolve) => {
		const contextIsInteraction = isContextInteraction(context);
		const idMod = `${context.id}-${Date.now()}`;
		const row = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents([
			new ButtonBuilder()
				.setStyle(ButtonStyle.Success)
				.setLabel(options?.confirmText ?? 'Confirm')
				.setCustomId(`confirmButton:${idMod}:${crypto.randomUUID()}`),

			new ButtonBuilder()
				.setStyle(ButtonStyle.Danger)
				.setLabel(options?.cancelText ?? 'Cancel')
				.setCustomId(`cancelButton:${idMod}:${crypto.randomUUID()}`),
		]);

		const sendMethod = () => {
			if (contextIsInteraction) {
				return context.replied || context.deferred ?
						context.editReply.bind(context)
					:	context.reply.bind(context);
			} else {
				if ('send' in context) {
					return context.send.bind(context);
				}

				const channel = (context as Message).channel as TextChannel;

				return channel.send.bind(channel);
			}
		};

		const extraParameters = contextIsInteraction ? { fetchReply: true, ephemeral: true } : {};
		const message = (await sendMethod()({
			...(typeof toPost === 'string' ? { content: toPost } : toPost),
			components: [row],
			...extraParameters,
		})) as Message;
		const collector = message.createMessageComponentCollector({ time: options?.collectorTime ?? 30_000 });

		collector.on('collect', async (interaction: MessageComponentInteraction) => {
			if (options?.restrictToId && options.restrictToId !== interaction.user.id) {
				interaction
					.reply({ content: `You are not permitted to use these buttons.`, ephemeral: true })
					// eslint-disable-next-line promise/prefer-await-to-then, promise/prefer-await-to-callbacks
					.catch((error) => console.trace(error.message));

				return;
			}

			if (interaction.customId.startsWith(`confirmButton:${idMod}:`)) {
				if (contextIsInteraction) {
					await interaction.deferUpdate();
				} else {
					void message.delete();
				}

				resolve({ context: interaction, confirmed: true });
			} else if (interaction.customId.startsWith(`cancelButton:${idMod}:`)) {
				if (contextIsInteraction) {
					await interaction.deferUpdate();
				} else {
					void message.delete();
				}

				resolve({ context: interaction, confirmed: false });
			}
		});

		collector.on('end', () => {
			if (!contextIsInteraction && message.deletable) {
				void message.delete().catch(() => {}); // eslint-disable-line promise/prefer-await-to-then
			}

			resolve({ context, confirmed: false });
		});
	});
}

export interface WaitForOptions {
	cancelText?: string;
	collectorTime?: number;
	confirmText?: string;
	restrictToId?: string;
}
