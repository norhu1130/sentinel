import { ApplyOptions } from '@sapphire/decorators';
import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import * as Sentry from '@sentry/node';
import { ButtonInteraction, EmbedBuilder, GuildMember, MessageFlags } from 'discord.js';
import { ClanManager, ClanMemberAddStatus, MAX_MEMBERS_IN_CLAN } from '../lib/abilities/ClanManager.js';
import { createErrorEmbed, createInfoEmbed } from '../lib/utils/createEmbed.js';
import { LogPrefix } from '../lib/utils/logPrefix.js';

// Custom ID format: clan.join.<accept|deny>:<requesterId>:<ownerId>:<clanRoleId>
export function makeClanJoinRequestId(
	action: 'accept' | 'deny',
	requesterId: string,
	ownerId: string,
	clanRoleId: string,
) {
	return `clan.join.${action}:${requesterId}:${ownerId}:${clanRoleId}` as const;
}

type UpdateMessageResult = 'Accepted' | 'Already Joined' | 'Denied' | 'Error' | 'Full' | 'Requester In Another Clan';

@ApplyOptions<InteractionHandler.Options>({
	interactionHandlerType: InteractionHandlerTypes.Button,
})
export class ClanJoinRequestHandler extends InteractionHandler {
	public override parse(interaction: ButtonInteraction<'cached'>) {
		if (!interaction.customId.startsWith('clan.join.')) {
			return this.none();
		}

		const parts = interaction.customId.split(':');
		if (parts.length !== 4) {
			this.container.logger.debug(
				`${LogPrefix.CLAN_JOIN_REQUEST} Invalid parts length: ${parts.length}. ID: ${interaction.customId}`,
			);
			return this.none();
		}

		// Destructure parts correctly based on format
		const [prefix, requesterId, ownerId, clanRoleId] = parts;
		const action = prefix.split('.')[2] as 'accept' | 'deny' | undefined;

		if (!action || (action !== 'accept' && action !== 'deny')) {
			this.container.logger.debug(
				`${LogPrefix.CLAN_JOIN_REQUEST} Invalid action part: ${action}. ID: ${interaction.customId}`,
			);
			return this.none();
		}

		// IMPORTANT: Only the clan owner can press these buttons
		if (interaction.user.id !== ownerId) {
			(async () => {
				try {
					await interaction.reply({
						embeds: [createErrorEmbed('Only the clan owner can respond to this request.')],
						flags: MessageFlags.Ephemeral,
					});
				} catch (error) {
					this.container.logger.error("Failed to send 'not owner' reply", error);
				}
			})();

			return this.none();
		}

		this.container.logger.debug(
			`${LogPrefix.CLAN_JOIN_REQUEST} Parsed successfully. Action: ${action}, Requester: ${requesterId}, Owner: ${ownerId}, Role: ${clanRoleId}`,
		);

		return this.some({
			action,
			requesterId,
			clanRoleId,
		});
	}

	public override async run(
		interaction: ButtonInteraction<'cached'>,
		data: InteractionHandler.ParseResult<this>,
	): Promise<void> {
		await interaction.deferUpdate();

		const { action, requesterId, clanRoleId } = data;
		const logPrefix = `[CLAN JOIN REQ @${requesterId}]`;
		const tags = { requesterId, ownerId: interaction.user.id, guildId: interaction.guildId, clanRoleId, action };

		Sentry.addBreadcrumb({
			category: 'clan',
			message: `${logPrefix} Processing join request`,
			level: 'info',
			data: tags,
		});

		this.container.logger.info(
			`${LogPrefix.CLAN_JOIN_REQUEST} Running handler for interaction ${interaction.id}. Guild: ${interaction.guildId}. Data: ${JSON.stringify(data)}`,
		);

		const updateOriginalMessage = async (result: UpdateMessageResult) => {
			try {
				if (!interaction.message?.embeds?.[0]) {
					this.container.logger.error(
						`${LogPrefix.CLAN_JOIN_REQUEST} Original message ${interaction.message.id} is missing embeds.`,
					);
					return;
				}

				const originalEmbed = EmbedBuilder.from(interaction.message.embeds[0]);
				originalEmbed.setFooter({ text: `${result} by ${interaction.user.tag}` });
				originalEmbed.setTimestamp(new Date());
				originalEmbed.setColor(
					result === 'Accepted' ? 'Green'
					: result === 'Denied' ? 'Red'
					: 'Grey',
				);
				await interaction.editReply({ embeds: [originalEmbed], components: [] });
			} catch (error) {
				this.container.logger.error(
					`${LogPrefix.CLAN_JOIN_REQUEST} Failed to edit original request message ${interaction.message.id}`,
					error,
				);
			}
		};

		try {
			const { action, requesterId, clanRoleId } = data;
			const clanOwner = interaction.member as GuildMember;

			// --- Use ClanManager ---
			this.container.logger.info(
				`${LogPrefix.CLAN_JOIN_REQUEST} Instantiating ClanManager for owner ${clanOwner.id}.`,
			);
			const clanManager = new ClanManager(clanOwner);

			// --- Fetch Clan Data via ClanManager ---
			this.container.logger.info(
				`${LogPrefix.CLAN_JOIN_REQUEST} Fetching clan data (role ${clanRoleId}) with members for validation.`,
			);
			const clan = await clanManager.getClan();
			const clanRole = await clanManager.getCustomRole(); // Fetches the role associated with the owner
			const clanMembers = await clanManager.getClanMembers();
			const memberCount = clanMembers.size;

			// --- Rigorous Clan Null/Member Checks ---
			// Check if clan and role (which is tied to clan) exist
			if (!clan || !clanRole) {
				this.container.logger.error(
					`${LogPrefix.CLAN_JOIN_REQUEST} Clan data or role not found for owner ${clanOwner.id}.`,
				);
				await updateOriginalMessage('Error');
				await interaction.followUp({
					embeds: [createErrorEmbed('Clan data could not be found. It might have been deleted.')],
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			// This check ensures the handler is for the correct clan, as clanRoleId is in the customId
			if (clan.customRoleId !== clanRoleId) {
				this.container.logger.error(
					`${LogPrefix.CLAN_JOIN_REQUEST} Mismatch! Handler for role ${clanRoleId} but owner's clan role is ${clan.customRoleId}.`,
				);
				await updateOriginalMessage('Error');
				await interaction.followUp({
					embeds: [createErrorEmbed('There was a mismatch with the clan data. Please try again.')],
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			this.container.logger.debug(
				`${LogPrefix.CLAN_JOIN_REQUEST} Fetched clan object successfully. Member count: ${memberCount}`,
			);

			// --- Fetch Requester ---
			this.container.logger.info(`${LogPrefix.CLAN_JOIN_REQUEST} Fetching requester ${requesterId}`);
			const requester = await interaction.guild.members.fetch(requesterId).catch(() => null);

			// --- Validation Requester/Role ---
			if (!requester) {
				this.container.logger.warn(`${LogPrefix.CLAN_JOIN_REQUEST} Requester ${requesterId} not found.`);
				await updateOriginalMessage('Error');
				await interaction.followUp({
					embeds: [createErrorEmbed('The user who requested to join could not be found.')],
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			if (!clanRole) {
				this.container.logger.warn(
					`${LogPrefix.CLAN_JOIN_REQUEST} Clan role ${clanRoleId} not found unexpectedly.`,
				);
				await updateOriginalMessage('Error');
				await interaction.followUp({
					embeds: [createErrorEmbed('The clan role seems to have been deleted.')],
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			// --- Handle Deny ---
			if (action === 'deny') {
				this.container.logger.info(
					`${LogPrefix.CLAN_JOIN_REQUEST} Denying request for ${requesterId} to join ${clanRoleId}.`,
				);
				await updateOriginalMessage('Denied');
				return;
			}

			// --- Handle Accept ---
			this.container.logger.info(
				`${LogPrefix.CLAN_JOIN_REQUEST} Processing ACCEPT for ${requesterId} to join ${clanRoleId}.`,
			);

			// --- Perform Validations using ClanManager data ---
			this.container.logger.info(
				`${LogPrefix.CLAN_JOIN_REQUEST} Validating clan capacity (${memberCount}/${MAX_MEMBERS_IN_CLAN}), existing membership.`,
			);

			if (memberCount >= MAX_MEMBERS_IN_CLAN) {
				await updateOriginalMessage('Full');
				await interaction.followUp({
					embeds: [createErrorEmbed(`Your clan **${clanRole.name}** is full.`)],
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			if (clanMembers.has(requester.id)) {
				await updateOriginalMessage('Already Joined');
				await interaction.followUp({
					embeds: [createErrorEmbed(`${requester.user.tag} is already in your clan.`)],
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			// --- START OF MODIFIED LOGIC ---
			// Removed the check for `existingMembership` as users can be in multiple clans.
			// --- END OF MODIFIED LOGIC ---

			// Attempt to add member
			this.container.logger.info(
				`${LogPrefix.CLAN_JOIN_REQUEST} Calling clanManager.inviteMember for requester ${requesterId}.`,
			);

			Sentry.addBreadcrumb({
				category: 'clan',
				message: `${logPrefix} Calling inviteMember`,
				level: 'info',
				data: tags,
			});

			const addStatus = await clanManager.inviteMember(requester.id, true, { actorUserId: interaction.user.id });
			this.container.logger.info(
				`${LogPrefix.CLAN_JOIN_REQUEST} clanManager.inviteMember returned status: ${ClanMemberAddStatus[addStatus]} (${addStatus})`,
			);

			Sentry.addBreadcrumb({
				category: 'clan',
				message: `${logPrefix} inviteMember completed`,
				level: 'info',
				data: { ...tags, addStatus, addStatusName: ClanMemberAddStatus[addStatus] },
			});

			if (addStatus === ClanMemberAddStatus.Added) {
				await updateOriginalMessage('Accepted');

				// Try to DM the requester (ignore if fails)
				try {
					await requester.send({
						embeds: [createInfoEmbed(`🎉 Your request to join **${clanRole.name}** was accepted!`)],
					});
				} catch {
					// Ignore DM failures
				}

				// Try to send welcome message to clan channel
				const clanChannel = await clanManager.getClanChannel();
				if (clanChannel) {
					try {
						await clanChannel.send(`Welcome ${requester.toString()} to the clan!`);
					} catch (error) {
						this.container.logger.error(
							`${LogPrefix.CLAN_JOIN_REQUEST} Failed to send welcome to clan channel ${clanChannel.id}`,
							error,
						);
					}
				}
			} else {
				Sentry.addBreadcrumb({
					category: 'clan',
					message: `${logPrefix} Join request failed: inviteMember returned error status`,
					level: 'warning',
					data: { ...tags, addStatus, addStatusName: ClanMemberAddStatus[addStatus] },
				});
				Sentry.withScope((scope) => {
					scope.setTags(tags);
					scope.setTag('operation', 'clanJoinRequest');
					scope.setExtra('addStatus', addStatus);
					scope.setExtra('addStatusName', ClanMemberAddStatus[addStatus]);
					Sentry.captureMessage(
						`${logPrefix} Join request failed with status: ${ClanMemberAddStatus[addStatus]}`,
						'warning',
					);
				});

				await updateOriginalMessage('Error');
				await interaction.followUp({
					embeds: [
						createErrorEmbed(`Failed to add member: ${ClanManager.getMemberAddStatusMessage(addStatus)}`),
					],
					flags: MessageFlags.Ephemeral,
				});
			}
		} catch (error) {
			this.container.logger.error(
				`${LogPrefix.CLAN_JOIN_REQUEST} UNEXPECTED ERROR during run for interaction ${interaction.id}:`,
				error,
			);

			Sentry.addBreadcrumb({
				category: 'clan',
				message: `${logPrefix} Unexpected error during join request processing`,
				level: 'error',
				data: { ...tags, error: String(error) },
			});
			Sentry.withScope((scope) => {
				scope.setTags(tags);
				scope.setTag('operation', 'clanJoinRequest');
				Sentry.captureException(error);
			});

			try {
				await interaction.followUp({
					embeds: [
						createErrorEmbed(
							'An unexpected error occurred while processing the request. Please check the bot logs or try again later.',
						),
					],
					flags: MessageFlags.Ephemeral,
				});
			} catch (followUpError) {
				this.container.logger.error(
					`${LogPrefix.CLAN_JOIN_REQUEST} Failed to send follow-up error message for interaction ${interaction.id}:`,
					followUpError,
				);
			}
		}
	}
}
