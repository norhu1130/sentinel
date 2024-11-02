import { ApplyOptions } from '@sapphire/decorators';
import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import type { ButtonInteraction } from 'discord.js';
import { ClanManager, ClanMemberAddStatus } from '../../../lib/abilities/ClanManager.js';
import { createInfoEmbed } from '../../../lib/utils/createEmbed.js';

const welcomeMessages = [
	'Quick, everyone! Hide!',
	'May the ritual commence.',
	'Better late than never, I guess.',
	`A team isn't complete without its bottom frag.`,
	`Who's up for swifties?`,
];

@ApplyOptions<InteractionHandler.Options>({
	interactionHandlerType: InteractionHandlerTypes.Button,
})
export class ClanInvite extends InteractionHandler {
	public override parse(interaction: ButtonInteraction) {
		if (!interaction.customId.startsWith('clan.invite.')) {
			return this.none();
		}

		const split = interaction.customId.slice(12).split(':');

		if (split.length !== 3) {
			return this.none();
		}

		if (!['accept', 'refuse'].includes(split[0])) {
			return this.none();
		}

		return this.some({
			invitedUser: split[1] as string,
			decision: split[0] as 'accept' | 'refuse',
			clanOwner: split[2] as string,
		});
	}

	public override async run(interaction: ButtonInteraction<'cached'>, data: InteractionHandler.ParseResult<this>) {
		if (interaction.user.id !== data.invitedUser) {
			await interaction.reply({
				embeds: [createInfoEmbed('This button was not meant for you.')],
				ephemeral: true,
			}).catch(error => this.container.logger.error(`[CLAN] (invite 2.1) Failed to reply to button interaction: ${error}`));

			return;
		}

		if (data.decision === 'refuse') {
			await interaction.update({
				content: `❌ The invitation was refused.`,
				components: [],
			}).catch(error => this.container.logger.error(`[CLAN] (invite 2.2) Failed to update button interaction: ${error}`));

			return;
		}

		await interaction.deferUpdate();

		const clanOwner = await interaction.guild.members.fetch(data.clanOwner).catch(() => {});

		if (!clanOwner) {
			await interaction.update({
				content: `❌ This invitation was sent by a member who does not seem to be in the server anymore.`,
				components: [],
			}).catch(error => this.container.logger.error(`[CLAN] (invite 2.3) Failed to update button interaction: ${error}`));

			return;
		}

		const clanManager = new ClanManager(clanOwner);

		const clanMemberAddStatus = await clanManager.inviteMember(data.invitedUser);

		if (clanMemberAddStatus !== ClanMemberAddStatus.Added) {
			let errorMessage = '';

			switch (clanMemberAddStatus) {
				case ClanMemberAddStatus.ClanNotFound:
					errorMessage = `❌ This invitation was sent by a member who does not seem to have a clan anymore.`;
					break;

				case ClanMemberAddStatus.AlreadyInClan:
					errorMessage = `❌ You are already in the clan.`;
					break;

				case ClanMemberAddStatus.InvitedMemberNotFound:
					errorMessage = `❌ Invited member could not be found. Please contact modmail to solve this issue.`;
					break;

				case ClanMemberAddStatus.CouldNotAddToChannel:
					errorMessage = `❌ Was not able to add member to the clan channel. Please contact modmail to solve this issue.`;
					break;
			}

			await interaction.update({
				content: errorMessage,
				components: [],
			}).catch(error => this.container.logger.error(`[CLAN] (invite 2.4) Failed to update button interaction: ${error}`));

			return;
		}

		await interaction.update({
			content: `✅ Invitation accepted.`,
			components: [],
		}).catch(error => this.container.logger.error(`[CLAN] (invite 2.5) Failed to update button interaction: ${error}`));

		await (await clanManager.getClanChannel())?.send(
			`<@${data.invitedUser}> has joined the clan! ${welcomeMessages[Math.floor(Math.random() * welcomeMessages.length)]}`
		).catch(error => this.container.logger.error(`[CLAN] (invite 2.6) Failed to update button interaction: ${error}`));
	}
}
