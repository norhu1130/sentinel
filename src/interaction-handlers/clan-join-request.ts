import type { ClanMember } from '@prisma/client'; // Import ClanMember type
import { ApplyOptions } from '@sapphire/decorators';
// Remove unused UserError import
import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import { ButtonInteraction, EmbedBuilder, GuildMember } from 'discord.js';
// Import MAX_MEMBERS_IN_CLAN
import { ClanManager, ClanMemberAddStatus, MAX_MEMBERS_IN_CLAN } from '../lib/abilities/ClanManager.js';
import { createErrorEmbed, createInfoEmbed } from '../lib/utils/createEmbed.js';

// Custom ID format: clan.join.<accept|deny>:<requesterId>:<ownerId>:<clanRoleId>
export function makeClanJoinRequestId(action: 'accept' | 'deny', requesterId: string, ownerId: string, clanRoleId: string) {
	return `clan.join.${action}:${requesterId}:${ownerId}:${clanRoleId}` as const;
}

@ApplyOptions<InteractionHandler.Options>({
	interactionHandlerType: InteractionHandlerTypes.Button,
})
export class ClanJoinRequestHandler extends InteractionHandler {
	public override parse(interaction: ButtonInteraction<'cached'>) {
		if (!interaction.customId.startsWith('clan.join.')) {
			return this.none();
		}

		const parts = interaction.customId.split(':');
		if (parts.length !== 4) return this.none();

        // Destructure parts correctly based on format
        const [prefix, requesterId, ownerId, clanRoleId] = parts;
        const action = prefix.split('.')[2] as 'accept' | 'deny' | undefined; // Get action from clan.join.action

        if (!action || (action !== 'accept' && action !== 'deny')) return this.none();

		if (interaction.user.id !== ownerId) {
            interaction.reply({ embeds: [createErrorEmbed('Only the clan owner can respond to this request.')], ephemeral: true }).catch(e => this.container.logger.error("Failed to send 'not owner' reply", e));
			return this.none();
		}

		return this.some({
			action,
			requesterId,
			// ownerId is no longer needed in run, but keep if useful for logging
            clanRoleId
		});
	}

	// Add return type Promise<void> and remove unnecessary returns
	public override async run(interaction: ButtonInteraction<'cached'>, data: InteractionHandler.ParseResult<this>): Promise<void> {
		await interaction.deferUpdate();

        // Destructure data correctly - ownerId is not needed here
        const { action, requesterId, clanRoleId } = data;

        const clanOwner = interaction.member as GuildMember; // We know this is the owner from parse()
		const requester = await interaction.guild.members.fetch(requesterId).catch(() => null);
        const clanRole = await interaction.guild.roles.fetch(clanRoleId).catch(() => null);

        const updateOriginalMessage = async (result: 'Accepted' | 'Denied' | 'Error' | 'Full' | 'Already Joined' | 'Requester In Another Clan') => {
            try {
                const originalEmbed = EmbedBuilder.from(interaction.message.embeds[0]);
                originalEmbed.setFooter({ text: `${result} by ${interaction.user.tag}` });
                originalEmbed.setTimestamp(new Date());
                originalEmbed.setColor(result === 'Accepted' ? 'Green' : result === 'Denied' ? 'Red' : 'Grey');

                await interaction.editReply({ embeds: [originalEmbed], components: [] });
            } catch (e) {
                this.container.logger.error(`[CLAN JOIN REQ] Failed to edit original request message ${interaction.message.id}`, e);
            }
        };

        if (!requester) {
            await updateOriginalMessage('Error');
            await interaction.followUp({ embeds: [createErrorEmbed('The user who requested to join could not be found.')], ephemeral: true });
            return;
        }
        if (!clanRole) {
             await updateOriginalMessage('Error');
             await interaction.followUp({ embeds: [createErrorEmbed('The clan role seems to have been deleted.')], ephemeral: true });
             return;
        }

		if (action === 'deny') {
			await updateOriginalMessage('Denied');
			return;
		}

        // --- Handle Accept ---
        const clanManager = new ClanManager(clanOwner);

        // Fetch clan data *with members* for validation
        const clan = await this.container.prisma.clan.findUnique({
             where: { guildId_customRoleId: { guildId: interaction.guildId, customRoleId: clanRoleId } },
             include: { members: true } // Ensure members are included
        });

        if (!clan) {
             await updateOriginalMessage('Error');
             await interaction.followUp({ embeds: [createErrorEmbed('Your clan data could not be found.')], ephemeral: true });
             return;
        }

        // Use imported constant and included members data
        if (clan.members.length >= MAX_MEMBERS_IN_CLAN) {
            await updateOriginalMessage('Full');
            await interaction.followUp({ embeds: [createErrorEmbed(`Your clan **${clanRole.name}** is full.`)], ephemeral: true });
            return;
        }

        // Use imported constant and included members data, add explicit type for 'm'
         if (clan.members.some((m: ClanMember) => m.userId === requester.id)) {
            await updateOriginalMessage('Already Joined');
            await interaction.followUp({ embeds: [createErrorEmbed(`${requester.user.tag} is already in your clan.`)] , ephemeral: true});
            return;
		}

        const existingMembership = await this.container.prisma.clanMember.findFirst({
            where: { userId: requester.id, clanGuildId: interaction.guildId }
        });
        if (existingMembership) {
             await updateOriginalMessage('Requester In Another Clan'); // More specific status
             const existingClan = await this.container.prisma.clan.findUnique({ where: { guildId_customRoleId: { guildId: existingMembership.clanGuildId, customRoleId: existingMembership.clanCustomRoleId }}});
             const existingClanRole = existingClan ? await interaction.guild.roles.fetch(existingClan.customRoleId).catch(() => null) : null;
             const clanName = existingClanRole ? `**${existingClanRole.name}**` : 'another clan';
			 await interaction.followUp({ embeds: [createErrorEmbed(`${requester.user.tag} is already a member of ${clanName}. They must leave it first.`)] , ephemeral: true});
             return;
        }


        // Attempt to add member
        const addStatus = await clanManager.inviteMember(requester.id, true);

        if (addStatus === ClanMemberAddStatus.Added) {
            await updateOriginalMessage('Accepted');
            requester.send({ embeds: [createInfoEmbed(`🎉 Your request to join **${clanRole.name}** was accepted!`)] }).catch(() => {});
            const clanChannel = await clanManager.getClanChannel();
            clanChannel?.send(`Welcome ${requester.toString()} to the clan!`).catch(e => this.container.logger.error(`[CLAN JOIN REQ] Failed to send welcome to clan channel ${clanChannel.id}`, e));
        } else {
             await updateOriginalMessage('Error');
             await interaction.followUp({ embeds: [createErrorEmbed(`Failed to add member: ${ClanManager.getMemberAddStatusMessage(addStatus)}`)], ephemeral: true });
        }
	}
}