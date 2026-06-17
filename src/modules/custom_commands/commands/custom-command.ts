import type { CustomCommand } from '@prisma/client';
import { Subcommand, type SubcommandMappingArray } from '@sapphire/plugin-subcommands';
import {
	type ApplicationCommandOptionChoiceData,
	type Attachment,
	type AutocompleteInteraction,
	InteractionContextType,
	MessageFlags,
} from 'discord.js';
import { MemberAbilities } from '../../../lib/abilities/MemberAbilities.js';
import { RoleAbilitiesCalculator } from '../../../lib/abilities/RoleAbilities.js';
import { createInfoEmbed } from '../../../lib/utils/createEmbed.js';
import { addCustomCommandName, removeCustomCommandName } from '../customCommandCache.js';
import {
	ALLOWED_MEDIA_EXTENSIONS,
	CUSTOM_COMMAND_MEDIA_MAX_BYTES,
	CUSTOM_COMMAND_PREFIX,
	type CustomCommandInputMode,
	fetchMediaBuffer,
	findAutoModViolation,
	getInputMode,
	getOwnedClan,
	isValidCommandName,
	isValidHttpUrl,
	MAX_CUSTOM_COMMANDS_PER_CLAN,
	normalizeCommandName,
} from '../customCommandUtils.js';

/**
 * Resolved media ready to persist, or an error message to show the user.
 */
type MediaResult =
	| { error: string; ok: false }
	| { ok: true; value: Pick<CustomCommand, 'mediaData' | 'mediaName' | 'mediaType' | 'mediaUrl'> | null };

export class CustomCommandCommand extends Subcommand {
	public subcommandMappings: SubcommandMappingArray = [
		{ type: 'method', name: 'create', chatInputRun: 'createSubcommand' },
		{ type: 'method', name: 'list', chatInputRun: 'listSubcommand' },
		{ type: 'method', name: 'edit', chatInputRun: 'editSubcommand' },
		{ type: 'method', name: 'delete', chatInputRun: 'deleteSubcommand' },
	];

	public async createSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		const clan = await this.ensureCanManage(interaction);
		if (!clan) {
			return;
		}

		const name = normalizeCommandName(interaction.options.getString('name', true));

		if (!isValidCommandName(name)) {
			await interaction.editReply({
				embeds: [
					createInfoEmbed(
						'Command names must be 1-32 characters and only contain lowercase letters, numbers, dashes, or underscores.',
					),
				],
			});
			return;
		}

		const text = interaction.options.getString('text', false);

		const media = await this.resolveMedia(interaction);

		if (!media.ok) {
			await interaction.editReply({ embeds: [createInfoEmbed(media.error)] });
			return;
		}

		if (!text && !media.value) {
			await interaction.editReply({
				embeds: [createInfoEmbed('A command needs at least some text or a media attachment/URL.')],
			});
			return;
		}

		if (await this.replyIfAutoModViolation(interaction, name, text, media.value?.mediaUrl ?? null)) {
			return;
		}

		const existing = await this.container.prisma.customCommand.findUnique({
			where: {
				guildId_clanCustomRoleId_name: {
					guildId: interaction.guildId,
					clanCustomRoleId: clan.customRoleId,
					name,
				},
			},
		});

		if (existing) {
			await interaction.editReply({
				embeds: [
					createInfoEmbed(
						`Your clan already has a \`${CUSTOM_COMMAND_PREFIX}${name}\` command. Use \`/custom-command edit\` to change it.`,
					),
				],
			});
			return;
		}

		const count = await this.container.prisma.customCommand.count({
			where: { guildId: interaction.guildId, clanCustomRoleId: clan.customRoleId },
		});

		if (count >= MAX_CUSTOM_COMMANDS_PER_CLAN) {
			await interaction.editReply({
				embeds: [
					createInfoEmbed(
						`Your clan has reached the limit of ${MAX_CUSTOM_COMMANDS_PER_CLAN} custom commands. Delete one before adding another.`,
					),
				],
			});
			return;
		}

		await this.container.prisma.customCommand.create({
			data: {
				guildId: interaction.guildId,
				clanCustomRoleId: clan.customRoleId,
				name,
				text: text ?? null,
				createdBy: interaction.user.id,
				...media.value,
			},
		});

		addCustomCommandName(interaction.guildId, name);

		await interaction.editReply({
			embeds: [
				createInfoEmbed(
					`Created \`${CUSTOM_COMMAND_PREFIX}${name}\`. Members of your clan can now use it. (${count + 1}/${MAX_CUSTOM_COMMANDS_PER_CLAN})`,
				),
			],
		});
	}

	public async editSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		const clan = await this.ensureCanManage(interaction);
		if (!clan) {
			return;
		}

		const name = normalizeCommandName(interaction.options.getString('name', true));

		const existing = await this.container.prisma.customCommand.findUnique({
			where: {
				guildId_clanCustomRoleId_name: {
					guildId: interaction.guildId,
					clanCustomRoleId: clan.customRoleId,
					name,
				},
			},
		});

		if (!existing) {
			await interaction.editReply({
				embeds: [createInfoEmbed(`Your clan doesn't have a \`${CUSTOM_COMMAND_PREFIX}${name}\` command.`)],
			});
			return;
		}

		const text = interaction.options.getString('text', false);
		const media = await this.resolveMedia(interaction);

		if (!media.ok) {
			await interaction.editReply({ embeds: [createInfoEmbed(media.error)] });
			return;
		}

		// Only overwrite fields the user actually provided this time.
		const newText = text ?? existing.text;
		const newMedia = media.value ?? {
			mediaData: existing.mediaData,
			mediaUrl: existing.mediaUrl,
			mediaType: existing.mediaType,
			mediaName: existing.mediaName,
		};

		if (!newText && !newMedia.mediaData && !newMedia.mediaUrl) {
			await interaction.editReply({
				embeds: [createInfoEmbed('A command needs at least some text or a media attachment/URL.')],
			});
			return;
		}

		if (await this.replyIfAutoModViolation(interaction, name, newText, newMedia.mediaUrl)) {
			return;
		}

		await this.container.prisma.customCommand.update({
			where: {
				guildId_clanCustomRoleId_name: {
					guildId: interaction.guildId,
					clanCustomRoleId: clan.customRoleId,
					name,
				},
			},
			data: { text: newText, ...newMedia },
		});

		await interaction.editReply({
			embeds: [createInfoEmbed(`Updated \`${CUSTOM_COMMAND_PREFIX}${name}\`.`)],
		});
	}

	public async deleteSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		const clan = await this.ensureCanManage(interaction);
		if (!clan) {
			return;
		}

		const name = normalizeCommandName(interaction.options.getString('name', true));

		const deleted = await this.container.prisma.customCommand
			.delete({
				where: {
					guildId_clanCustomRoleId_name: {
						guildId: interaction.guildId,
						clanCustomRoleId: clan.customRoleId,
						name,
					},
				},
			})
			.catch(() => null);

		if (!deleted) {
			await interaction.editReply({
				embeds: [createInfoEmbed(`Your clan doesn't have a \`${CUSTOM_COMMAND_PREFIX}${name}\` command.`)],
			});
			return;
		}

		await removeCustomCommandName(interaction.guildId, name);

		await interaction.editReply({
			embeds: [createInfoEmbed(`Deleted \`${CUSTOM_COMMAND_PREFIX}${name}\`.`)],
		});
	}

	public async listSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		const clan = await this.ensureCanManage(interaction);
		if (!clan) {
			return;
		}

		const commands = await this.container.prisma.customCommand.findMany({
			where: { guildId: interaction.guildId, clanCustomRoleId: clan.customRoleId },
			orderBy: { name: 'asc' },
		});

		if (commands.length === 0) {
			await interaction.editReply({
				embeds: [
					createInfoEmbed(
						"Your clan doesn't have any custom commands yet. Create one with `/custom-command create`.",
					),
				],
			});
			return;
		}

		const lines = commands.map((command: CustomCommand) => {
			const parts: string[] = [];
			if (command.text) {
				parts.push('text');
			}

			if (command.mediaData) {
				parts.push('upload');
			}

			if (command.mediaUrl) {
				parts.push('link');
			}

			return `\`${CUSTOM_COMMAND_PREFIX}${command.name}\` — ${parts.join(' + ') || 'empty'}`;
		});

		await interaction.editReply({
			embeds: [
				createInfoEmbed(
					`Your clan's custom commands (${commands.length}/${MAX_CUSTOM_COMMANDS_PER_CLAN}):\n\n${lines.join('\n')}`,
				),
			],
		});
	}

	public override async autocompleteRun(interaction: AutocompleteInteraction<'cached'>) {
		const focused = interaction.options.getFocused(true);

		if (focused.name !== 'name') {
			return interaction.respond([]);
		}

		const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
		const clan = member ? await getOwnedClan(member) : null;

		if (!clan) {
			return interaction.respond([]);
		}

		const input = normalizeCommandName(focused.value);

		const commands = await this.container.prisma.customCommand.findMany({
			where: { guildId: interaction.guildId, clanCustomRoleId: clan.customRoleId },
			orderBy: { name: 'asc' },
			take: 25,
		});

		const options: ApplicationCommandOptionChoiceData[] = commands
			.filter((command: CustomCommand) => command.name.includes(input))
			.slice(0, 25)
			.map((command: CustomCommand) => ({
				name: `${CUSTOM_COMMAND_PREFIX}${command.name}`,
				value: command.name,
			}));

		return interaction.respond(options);
	}

	public override registerApplicationCommands(registry: Subcommand.Registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName(this.name)
				.setDescription("Create and manage your clan's custom commands.")
				.setContexts(InteractionContextType.Guild)
				.addSubcommand((subcommand) =>
					subcommand
						.setName('create')
						.setDescription('Create a new custom command for your clan.')
						.addStringOption((option) =>
							option
								.setName('name')
								.setDescription('Trigger name, used as !name (letters, numbers, dashes, underscores)')
								.setMinLength(1)
								.setMaxLength(33)
								.setRequired(true),
						)
						.addStringOption((option) =>
							option.setName('text').setDescription('Text the bot replies with').setMaxLength(2_000),
						)
						.addAttachmentOption((option) =>
							option.setName('media').setDescription('Media file to upload (image/gif/video, max 4MB)'),
						)
						.addStringOption((option) =>
							option.setName('media_url').setDescription('External media URL to reply with'),
						),
				)
				.addSubcommand((subcommand) =>
					subcommand.setName('list').setDescription("List your clan's custom commands."),
				)
				.addSubcommand((subcommand) =>
					subcommand
						.setName('edit')
						.setDescription("Edit one of your clan's custom commands.")
						.addStringOption((option) =>
							option
								.setName('name')
								.setDescription('The command to edit')
								.setRequired(true)
								.setAutocomplete(true),
						)
						.addStringOption((option) =>
							option.setName('text').setDescription('New reply text').setMaxLength(2_000),
						)
						.addAttachmentOption((option) =>
							option.setName('media').setDescription('New media file (image/gif/video, max 4MB)'),
						)
						.addStringOption((option) =>
							option.setName('media_url').setDescription('New external media URL'),
						),
				)
				.addSubcommand((subcommand) =>
					subcommand
						.setName('delete')
						.setDescription("Delete one of your clan's custom commands.")
						.addStringOption((option) =>
							option
								.setName('name')
								.setDescription('The command to delete')
								.setRequired(true)
								.setAutocomplete(true),
						),
				),
		);
	}

	/**
	 * Verifies the caller has the ability and owns a clan; replies with the reason and returns
	 * undefined when they cannot manage commands. Assumes the interaction is already deferred.
	 */
	private async ensureCanManage(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		const roleAbilitiesCalculator = new RoleAbilitiesCalculator(interaction.guildId);
		const memberAbilities = new MemberAbilities(interaction.member);

		await roleAbilitiesCalculator.computeList();
		await memberAbilities.computeAbilities();

		if (roleAbilitiesCalculator.getPremiumRoleIds('canCreateCustomCommand').length < 1) {
			await interaction.editReply({
				embeds: [createInfoEmbed("This server doesn't have custom commands enabled.")],
			});
			return undefined;
		}

		if (!memberAbilities.hasAbility('canCreateCustomCommand')) {
			await interaction.editReply({
				embeds: [createInfoEmbed('You do not have the ability to create custom commands.')],
			});
			return undefined;
		}

		const clan = await getOwnedClan(interaction.member);

		if (!clan) {
			await interaction.editReply({
				embeds: [createInfoEmbed('You need to own a clan before you can create custom commands for it.')],
			});
			return undefined;
		}

		return clan;
	}

	/**
	 * Checks the command's name and reply content against the guild's keyword AutoMod rules. When a
	 * rule would block it, replies with the reason and returns true so the caller can bail out;
	 * returns false when the content is clean. Assumes the interaction is already deferred.
	 */
	private async replyIfAutoModViolation(
		interaction: Subcommand.ChatInputCommandInteraction<'cached'>,
		name: string,
		text: string | null,
		mediaUrl: string | null,
	): Promise<boolean> {
		const content = [name, text, mediaUrl].filter(Boolean).join('\n');
		const violation = await findAutoModViolation(interaction.guild, content);

		if (!violation) {
			return false;
		}

		// Strip backticks so the matched text can't break out of the inline code span.
		// const match = violation.match.replaceAll('`', '');

		await interaction.editReply({
			embeds: [
				createInfoEmbed(
					`That command can't be saved because it would be blocked by this server's AutoMod rule`// **${violation.ruleName}** (matched \`${match}\`).`,
				),
			],
		});

		return true;
	}

	/**
	 * Resolves the media supplied on the interaction (attachment and/or URL), enforcing the guild's
	 * input mode, size cap and media-type allowlist. Returns `{ ok: true, value: null }` when no
	 * media was supplied.
	 */
	private async resolveMedia(interaction: Subcommand.ChatInputCommandInteraction<'cached'>): Promise<MediaResult> {
		const attachment = interaction.options.getAttachment('media', false);
		const url = interaction.options.getString('media_url', false);

		if (attachment && url) {
			return { ok: false, error: 'Please provide either a media file or a media URL, not both.' };
		}

		const mode = await getInputMode(interaction.guildId);

		if (attachment) {
			if (!this.modeAllows(mode, 'upload')) {
				return { ok: false, error: 'This server only allows media commands via a URL, not file uploads.' };
			}

			return this.resolveAttachment(attachment);
		}

		if (url) {
			if (!this.modeAllows(mode, 'url')) {
				return { ok: false, error: 'This server only allows media commands via file upload, not URLs.' };
			}

			if (!isValidHttpUrl(url)) {
				return { ok: false, error: 'That media URL is not a valid http(s) URL.' };
			}

			return { ok: true, value: { mediaData: null, mediaUrl: url, mediaType: null, mediaName: null } };
		}

		return { ok: true, value: null };
	}

	private modeAllows(mode: CustomCommandInputMode, method: 'upload' | 'url'): boolean {
		return mode === 'both' || mode === method;
	}

	private async resolveAttachment(attachment: Attachment): Promise<MediaResult> {
		// Validate by file extension (cheap, and avoids downloading rejected files).
		const extension = attachment.name?.split('.').pop()?.toLowerCase() ?? '';

		if (!Object.hasOwn(ALLOWED_MEDIA_EXTENSIONS, extension)) {
			return {
				ok: false,
				error: 'Custom command media must be an image (PNG, JPG, GIF, WEBP) or video (MP4, WEBM).',
			};
		}

		if (attachment.size > CUSTOM_COMMAND_MEDIA_MAX_BYTES) {
			return {
				ok: false,
				error: `That file is too large. Custom command media must be ${CUSTOM_COMMAND_MEDIA_MAX_BYTES / (1_024 * 1_024)}MB or smaller.`,
			};
		}

		// Try the signed CDN url first, then fall back to the proxy host if that connection stalls.
		let buffer = await fetchMediaBuffer(attachment.url);

		if (!buffer && attachment.proxyURL && attachment.proxyURL !== attachment.url) {
			buffer = await fetchMediaBuffer(attachment.proxyURL);
		}

		if (!buffer) {
			return { ok: false, error: 'I was unable to download that file. Try again with a different one.' };
		}

		return {
			ok: true,
			value: {
				mediaData: buffer,
				mediaUrl: null,
				mediaType: ALLOWED_MEDIA_EXTENSIONS[extension],
				mediaName: attachment.name ?? `media.${extension}`,
			},
		};
	}
}
