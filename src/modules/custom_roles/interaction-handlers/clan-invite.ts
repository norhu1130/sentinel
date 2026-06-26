import { ApplyOptions } from '@sapphire/decorators';
import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import type { ButtonInteraction } from 'discord.js';
import { ClanManager, ClanMemberAddStatus } from '../../../lib/abilities/ClanManager.js';
import { LogPrefix } from '../../../lib/utils/logPrefix.js';

const welcomeMessages = [
	'Quick, everyone! Hide!',
	'May the ritual commence.',
	'Better late than never, I guess.',
	`A team isn't complete without its bottom frag.`,
	`Who's up for swifties?`,
	'Initiating lockdown sequence. Exit doors locked.',
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

		if (interaction.user.id !== (split[1] as string)) {
			return this.none();
		}

		return this.some({
			invitedUser: split[1] as string,
			decision: split[0] as 'accept' | 'refuse',
			clanOwner: split[2] as string,
		});
	}

	public override async run(interaction: ButtonInteraction<'cached'>, data: InteractionHandler.ParseResult<this>) {
		if (data.decision === 'refuse') {
			await interaction
				.update({
					content: `❌ The invitation was refused.`,
					components: [],
				})
				.catch((error) =>
					this.container.logger.error(
						`${LogPrefix.CLAN} (invite 2.10) Failed to update button interaction: ${error}`,
					),
				);

			return;
		}

		await interaction.deferUpdate();

		const clanOwner = await interaction.guild.members.fetch(data.clanOwner).catch(() => {});

		if (!clanOwner) {
			await interaction
				.editReply({
					content: `❌ This invitation was sent by a member who does not seem to be in the server anymore.`,
					components: [],
				})
				.catch((error) =>
					this.container.logger.error(
						`${LogPrefix.CLAN} (invite 2.20) Failed to update button interaction: ${error}`,
					),
				);

			return;
		}

		const clanManager = new ClanManager(clanOwner);

		const clanMemberAddStatus = await clanManager.inviteMember(data.invitedUser, false, {
			actorUserId: data.invitedUser,
		});

		if (clanMemberAddStatus !== ClanMemberAddStatus.Added) {
			await interaction
				.editReply({
					content: ClanManager.getMemberAddStatusMessage(clanMemberAddStatus),
					components: [],
				})
				.catch((error) =>
					this.container.logger.error(
						`${LogPrefix.CLAN} [${clanOwner.id}] (invite 2.30) Failed to update button interaction: ${error}`,
					),
				);

			return;
		}

		await interaction
			.editReply({
				content: `✅ Invitation accepted.`,
				components: [],
			})
			.catch((error) =>
				this.container.logger.error(
					`${LogPrefix.CLAN} [${clanOwner.id}] (invite 2.40) Failed to update button interaction: ${error}`,
				),
			);

		await (await clanManager.getClanChannel())
			?.send(
				`<@${data.invitedUser}> has joined the clan! ${welcomeMessages[Math.floor(Math.random() * welcomeMessages.length)]}`,
			)
			.catch((error) =>
				this.container.logger.error(
					`${LogPrefix.CLAN} [${clanOwner.id}] (invite 2.50) Failed to update button interaction: ${error}`,
				),
			);
	}
}
