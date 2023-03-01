import { time } from '@discordjs/builders';
import { Command } from '@sapphire/framework';
import { Time } from '@sapphire/time-utilities';
import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ChatInputCommandInteraction,
	EmbedBuilder,
	GuildMember,
	Message,
	VoiceChannel,
} from 'discord.js';
import { UserError } from '../lib/extensions/UserError.js';
import { getMemberFromInteraction } from '../lib/utils.js';
import { announceAlreadyStartedVoteKick, createVoteKick } from '../lib/utils/votekick.js';

const cooldowns = new Map<string, { expiresAt: number }>();

export class VoteKick extends Command {
	public override async messageRun(message: Message) {
		if (message.author.id !== '139836912335716352') {
			return;
		}

		// Cannot run command outside guild
		// commands/votekick.ts, m:slashCommand, l:231
		await message.channel.send({
			content: 'VOTE_COMMAND_CANNOT_RUN_OUTSIDE_GUILD_MESSAGE',
			embeds: [
				new EmbedBuilder().setColor('Red').setDescription('Cannot run this command outside of a guild channel!'),
			],
		});

		// Member outside voice channel
		// commands/votekick.ts, m:slashCommand, l:240
		await message.channel.send({
			content: 'VOTE_COMMAND_NEED_TO_BE_IN_VOICE_CHANNEL_MESSAGE',
			embeds: [
				new EmbedBuilder()
					.setColor('Red')
					.setDescription('You need to be in a voice channel to be able to use this command!'),
			],
		});

		// Channel limit is less than 3 but not 0 (prevent duo channels, but allows infinite member channels)
		// commands/votekick.ts, m:slashCommand, l:247
		await message.channel.send({
			content: 'VOTE_COMMAND_CHANNEL_LIMIT_IS_TOO_SMALL_MESSAGE',
			embeds: [
				new EmbedBuilder().setColor('Red').setDescription('You cannot run this command in such a small voice channel!'),
			],
		});

		// Channel has less than 3 members
		// commands/votekick.ts, m:slashCommand, l:252
		await message.channel.send({
			content: 'VOTE_COMMAND_CHANNEL_HAS_TOO_FEW_MEMBERS_MESSAGE',
			embeds: [
				new EmbedBuilder()
					.setColor('Red')
					.setDescription("There aren't enough members in this voice channel to start a vote!"),
			],
		});

		// User is not in the same voice channel as invoker
		// commands/votekick.ts, m:slashCommand, l:257
		await message.channel.send({
			content: 'VOTE_COMMAND_USER_TO_KICK_IS_NOT_IN_VOICE_CHANNEL_MESSAGE',
			embeds: [new EmbedBuilder().setColor('Red').setDescription("That user is not in the voice channel you're in!")],
		});

		// User cannot kick themselves
		// commands/votekick.ts, m:slashCommand, l:262
		await message.channel.send({
			content: 'VOTE_COMMAND_USER_TO_KICK_CANNOT_BE_INVOKER_MESSAGE',
			embeds: [
				new EmbedBuilder()
					.setColor('Red')
					.setDescription('You cannot start a vote kick for yourself! Just press the disconnect button instead.'),
			],
		});

		// Already existing vote
		// lib/votekick.ts, l:90-110
		await message.channel.send({
			content: 'VOTE_ALREADY_PRESENT_MESSAGE',
			embeds: [
				new EmbedBuilder()
					.setColor('Red')
					.setDescription(
						`A vote to kick **Example User#0000 (1)** was already started.\n\nClick the button below to jump to that message`,
					)
					.setThumbnail(this.container.client.user!.displayAvatarURL({ size: 256, extension: 'png' })),
			],
			components: [
				new ActionRowBuilder<ButtonBuilder>().addComponents(
					new ButtonBuilder() //
						.setURL(message.url)
						.setLabel('Jump to message')
						.setStyle(ButtonStyle.Link),
				),
			],
		});

		// Vote started message
		// lib/votekick.ts, l:31-69
		await message.channel.send({
			content: 'VOTE_STARTED_OR_RUNNING_MESSAGE',
			embeds: [
				new EmbedBuilder() //
					.setColor('Blurple')
					.setDescription(`A vote to kick **Example User#0000 (1)** was started!`)
					.addFields(
						{ name: 'Members agreeing with vote', value: '1', inline: true },
						{ name: 'Members disagreeing with vote', value: '1', inline: true },
					)
					.setFooter({ text: `This vote needs <COUNT OF MINIMUM VOTES IN ONE DIRECTION> votes to pass.` })
					.setThumbnail(this.container.client.user!.displayAvatarURL({ size: 256, extension: 'png' })),
			],
			components: [
				new ActionRowBuilder<ButtonBuilder>().addComponents(
					new ButtonBuilder()
						.setCustomId('ignored')
						.setStyle(ButtonStyle.Secondary)
						.setLabel('Agree with vote')
						.setEmoji('check:889466938433101835'),
					new ButtonBuilder()
						.setCustomId('ignored-2')
						.setStyle(ButtonStyle.Secondary)
						.setLabel('Disagree with vote')
						.setEmoji('❌'),
				),
			],
		});

		// Cannot cast same vote
		// listeners/interactions/buttonPresses.ts, l:45-48
		await message.channel.send({
			content: 'VOTE_CANNOT_CAST_SAME_VOTE_MESSAGE',
			embeds: [new EmbedBuilder().setColor('Red').setDescription('You cannot cast the same vote!')],
		});

		// Vote was registered
		// listeners/interactions/buttonPresses.ts, l:107-110
		await message.channel.send({
			content: 'VOTE_REGISTERED_MESSAGE',
			embeds: [new EmbedBuilder().setColor('Green').setDescription('Your vote was casted successfully')],
		});

		// Tied vote
		// tasks/handleVoteResult.ts, l:100-121
		await message.channel.send({
			content: 'VOTE_FINISHED_TIE_MESSAGE',
			embeds: [
				new EmbedBuilder()
					.setColor('Yellow')
					.setDescription(
						[
							`The vote to kick **Example User#0000 (1)** ended!`,
							'',
							`The result is: **no actions will be taken, as the vote didn't have a majority of the votes on one side**!`,
						].join('\n'),
					)
					.setFields(
						{ name: 'Members agreeing with vote', value: '1', inline: true },
						{
							name: 'Members disagreeing with vote',
							value: '1',
							inline: true,
						},
					)
					.setThumbnail(this.container.client.user!.displayAvatarURL({ size: 256, extension: 'png' })),
			],
		});

		// Proceed with kick
		// tasks/handleVoteResult.ts, l:100-121
		await message.channel.send({
			content: 'VOTE_FINISHED_PROCEED_MESSAGE',
			embeds: [
				new EmbedBuilder()
					.setColor('Green')
					.setDescription(
						[
							`The vote to kick **Example User#0000 (1)** ended!`,
							'',
							`The result is: **the user was kicked and timed out from joining voice channels**!`,
						].join('\n'),
					)
					.setFields(
						{ name: 'Members agreeing with vote', value: '1', inline: true },
						{
							name: 'Members disagreeing with vote',
							value: '1',
							inline: true,
						},
					)
					.setThumbnail(this.container.client.user!.displayAvatarURL({ size: 256, extension: 'png' })),
			],
		});

		// Ignore vote
		// tasks/handleVoteResult.ts, l:100-121
		await message.channel.send({
			content: 'VOTE_FINISHED_IGNORE_MESSAGE',
			embeds: [
				new EmbedBuilder()
					.setColor('Red')
					.setDescription(
						[
							`The vote to kick **Example User#0000 (1)** ended!`,
							'',
							`The result is: **the user won't be kicked out as the majority voted against it**!`,
						].join('\n'),
					)
					.setFields(
						{ name: 'Members agreeing with vote', value: '1', inline: true },
						{
							name: 'Members disagreeing with vote',
							value: '1',
							inline: true,
						},
					)
					.setThumbnail(this.container.client.user!.displayAvatarURL({ size: 256, extension: 'png' })),
			],
		});

		// Modlog entry
		// tasks/handleVoteResult.ts, l:170-190
		await message.channel.send({
			content: 'MODLOG_ENTRY',
			embeds: [
				new EmbedBuilder()
					.setColor('Blurple')
					.setDescription(
						[
							`Vote started by: **Example User#0000 (1)**`,
							`Vote started for: **Example User#0000 (1)**`,
							// `Total votes: **${
							// 	vote.voters_agreeing_with_kick.length + vote.voters_disagreeing_with_kick.length
							// }**`,
							// `Voters agreeing kick: ${vote.voters_agreeing_with_kick.map((id) => `<@${id}>`).join(', ')}`,
							// `Voters disagreeing kick: ${vote.voters_disagreeing_with_kick.map((id) => `<@${id}>`).join(', ')}`,
							`Action taken: **NotEnoughVotes OR Kick OR Ignore**`,
						].join('\n'),
					)
					.setThumbnail(this.container.client.user!.displayAvatarURL({ size: 256, extension: 'png' }))
					.setFooter({ text: 'Started at' })
					.setTimestamp(),
			],
		});

		// Member timed out temporarily
		// tasks/handleVoteResult.ts, l:146-158
		await message.channel.send({
			content: 'MEMBER_TIMED_OUT_TEMPORARILY_DM',
			embeds: [
				new EmbedBuilder()
					.setColor('Red')
					.setDescription(
						`You have been timed out from voice channels. You will be unmuted at ${time(new Date(), 'T')}`,
					),
			],
		});

		// Member timed out permanently
		// tasks/handleVoteResult.ts, l:146-158
		await message.channel.send({
			content: 'MEMBER_TIMED_OUT_PERMANENTLY_DM',
			embeds: [
				new EmbedBuilder()
					.setColor('Red')
					.setDescription(
						'You have been timed out permanently from voice channels. Please contact ModMail to appeal this.',
					),
			],
		});

		throw new UserError('Cannot run this command outside slash commands! Use `/votekick` instead.');
	}

	public override async chatInputRun(interaction: ChatInputCommandInteraction) {
		// If command is ran in DMs, throw
		if (!interaction.guildId) throw new UserError('Cannot run this command outside of a guild channel!');

		// If the command was ran in a channel that's not intended to be used, throw
		if (interaction.channelId !== process.env.LFG_VOTEKICK_CHANNEL ?? '864629778894815273') {
			throw new UserError(
				`Cannot run this command outside the <#${process.env.LFG_VOTEKICK_CHANNEL ?? '864629778894815273'}> channel!`,
			);
		}

		const userToKick = interaction.options.getUser('user_to_kick', true);

		// Fetch the guild and the member who ran this command
		const member = (await getMemberFromInteraction(interaction)) as GuildMember;

		// If member is not in a voice channel, abort
		if (!member.voice.channelId) {
			throw new UserError('You need to be in a voice channel to be able to use this command!');
		}

		const voiceChannel = member.voice.channel as VoiceChannel;

		// If the voice channel expects less than 3 members, but not infinite, throw
		if (voiceChannel.userLimit < 3 && voiceChannel.userLimit !== 0) {
			throw new UserError('You cannot run this command in such a small voice channel!');
		}

		// If the voice channel doesn't have at least 3 members, we cannot start a vote
		if (voiceChannel.members.size < 3) {
			throw new UserError("There aren't enough members in this voice channel to start a vote!");
		}

		// If the user to kick isn't in the voice channel the runner of the command is, throw
		if (!voiceChannel.members.has(userToKick.id)) {
			throw new UserError("That user is not in the voice channel you're in!");
		}

		// If the user who started the kick wants to kick themselves..tell them to just disconnect
		if (userToKick.id === member.user.id) {
			throw new UserError('You cannot start a vote kick for yourself! Just press the disconnect button instead.');
		}

		// See if a kick was already started for this user
		const existingKick = await this.container.prisma.voteKick.findFirst({
			where: { user_to_kick: userToKick.id, voice_channel_id: member.voice.channelId },
		});

		// If an existing kick vote already exists, redirect the user to it
		if (existingKick) {
			await announceAlreadyStartedVoteKick(interaction, userToKick, existingKick);
			return;
		}

		const cooldownEntry = cooldowns.get(interaction.user.id);
		const now = Date.now();

		if ((cooldownEntry?.expiresAt ?? 0) > now) {
			await interaction.reply({
				ephemeral: true,
				embeds: [
					new EmbedBuilder()
						.setColor('Red')
						.setDescription(
							`You can run this command again **${time(new Date(cooldownEntry?.expiresAt ?? now), 'R')}**`,
						),
				],
			});
			return;
		}

		// Create a new voice kick
		await createVoteKick(interaction, userToKick, voiceChannel);
		// Timeout further voice kicks
		cooldowns.set(interaction.user.id, { expiresAt: Date.now() + Time.Minute * 5 });
	}

	public override registerApplicationCommands(registry: Command.Registry) {
		registry.registerChatInputCommand((command) =>
			command
				.setName('votekick')
				.setDescription("Starts a vote to kick a user from the voice channel if they're misbehaving")
				.addUserOption((option) =>
					option //
						// Keep in sync with src/commands/votekick.ts, line 16
						.setName('user_to_kick')
						.setDescription('The user who you wish to start a vote for')
						.setRequired(true),
				)
				.addStringOption((reason) =>
					reason //
						.setName('reason')
						.setDescription('The reason for the vote kick')
						.setRequired(true)
						.setMinLength(5),
				)
				.setDMPermission(false),
		);
	}
}
