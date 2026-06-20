import type { PremiumMember } from '@prisma/client';
import { Duration } from '@sapphire/time-utilities';
import * as Sentry from '@sentry/node';
import { ClanManager } from '../lib/abilities/ClanManager.js';
import { MemberAbilities } from '../lib/abilities/MemberAbilities.js';
import { Task, type TaskRunData } from '../lib/schedule/tasks/Task.js';
import { LogPrefix } from '../lib/utils/logPrefix.js';

export type FixMode = 'dry-run' | 'fix-all' | 'fix-mismatches' | 'fix-missing';

/**
 * What {@link CheckPremiumMemberAbilities.cleanupPremiumMember} actually did, so callers can keep
 * their counters honest:
 * - `deleted`: the premium member entry (and any standalone role/gift) was removed.
 * - `orphaned`: the member owns a clan that had no grace period, so it was orphaned and the premium
 *   entry was preserved.
 * - `skipped`: nothing was changed (already orphaned, guild missing, or a transient error).
 */
type CleanupOutcome = 'deleted' | 'orphaned' | 'skipped';

export interface CheckPremiumMemberAbilitiesOptions {
	/**
	 * What to fix: 'dry-run' (default), 'fix-missing', 'fix-mismatches', or 'fix-all'
	 */
	fixMode?: FixMode;
	/**
	 * Optional guild ID to check only a specific guild
	 */
	guildId?: string;
}

export interface CheckPremiumMemberAbilitiesResult {
	fixed: number;
	orphanedClansFixed: number;
	staleGiftsFixed: number;
	strayPickUsersFixed: number;
	totalChecked: number;
	totalMismatches: number;
	totalMissing: number;
	totalOrphanedClansWithoutTask: number;
	totalStaleGifts: number;
	totalStrayPickUsers: number;
}

const LOG_PREFIX = LogPrefix.PREMIUM_ABILITY_CHECK;

function addBreadcrumb(message: string, data?: Record<string, unknown>, level: Sentry.SeverityLevel = 'info'): void {
	Sentry.addBreadcrumb({
		category: 'premium-ability-check',
		message: `${LOG_PREFIX} ${message}`,
		level,
		data,
	});
}

function captureError(error: Error, context: string, extra?: Record<string, unknown>): void {
	Sentry.withScope((scope) => {
		scope.setTag('operation', 'premium-ability-check');
		scope.setExtra('context', context);
		if (extra) {
			scope.setExtras(extra);
		}

		Sentry.captureException(error);
	});
}

function captureWarning(message: string, extra?: Record<string, unknown>): void {
	Sentry.withScope((scope) => {
		scope.setTag('operation', 'premium-ability-check');
		scope.setLevel('warning');
		if (extra) {
			scope.setExtras(extra);
		}

		Sentry.captureMessage(`${LOG_PREFIX} ${message}`, 'warning');
	});
}

/**
 * Daily task that checks if premium members still have their expected abilities.
 * Logs any discrepancies for monitoring and debugging.
 */
export class CheckPremiumMemberAbilities extends Task {
	public async run(data?: TaskRunData) {
		addBreadcrumb('Task run() called', { hasData: Boolean(data?.data) });

		try {
			const options: CheckPremiumMemberAbilitiesOptions = data?.data ? JSON.parse(data.data) : {};
			addBreadcrumb('Parsed options', {
				fixMode: options.fixMode ?? 'dry-run',
				guildId: options.guildId ?? 'all',
			});
			await this.checkAbilities(options);
			addBreadcrumb('Task completed successfully');
		} catch (error) {
			addBreadcrumb('Task run() failed with unhandled error', { error: String(error) }, 'error');
			captureError(error as Error, 'run: unhandled error in task');
			this.container.logger.error(`${LOG_PREFIX} Unhandled error in task:`, error);
		}

		return null;
	}

	/**
	 * Cleans up a premium member who lost their abilities or left the server.
	 *
	 * A grace period only matters when there's a real clan to save, so:
	 * - Owns a clan that's already orphaned: do nothing - let the grace period (or a manual restore)
	 *   handle it, and keep the premium entry + gift intact.
	 * - Owns a clan with no grace period yet (e.g. they left while the bot was offline, so the live
	 *   leave listener never orphaned it): orphan it now and keep the premium entry + gift so the
	 *   owner can still be restored.
	 * - No clan (or only a standalone custom role): delete the role, revoke any gift, and remove the
	 *   premium member entry immediately.
	 *
	 * Returns what happened so the caller can keep its counters accurate.
	 */
	private async cleanupPremiumMember(
		premiumMember: PremiumMember,
		guildName: string,
		reason: 'mismatch' | 'missing',
	): Promise<CleanupOutcome> {
		const { guildId, userId, customRoleId } = premiumMember;
		addBreadcrumb('Starting cleanupPremiumMember', { guildId, userId, customRoleId, guildName, reason });
		this.container.logger.info(
			`${LOG_PREFIX} [CLEANUP] Starting cleanup for ${reason} premium member ${userId} in guild ${guildName} (${guildId}) (customRoleId=${customRoleId ?? 'none'}, gift=${premiumMember.giftedRoleToUserId ?? 'none'})`,
		);

		const guild = this.container.client.guilds.resolve(guildId);
		if (!guild) {
			addBreadcrumb('cleanupPremiumMember: guild not found', { guildId }, 'warning');
			this.container.logger.warn(
				`${LOG_PREFIX} [CLEANUP] Guild ${guildId} not found; skipping cleanup for ${userId}`,
			);
			return 'skipped';
		}

		if (customRoleId) {
			addBreadcrumb('Checking for clan', { customRoleId });
			const clanManager = new ClanManager(customRoleId, guildId);

			let clan;
			try {
				clan = await clanManager.getClan();
				addBreadcrumb('Clan lookup completed', { found: Boolean(clan), customRoleId });
			} catch (error) {
				// Never destroy a possible clan owner's data on a transient lookup error - defer instead.
				addBreadcrumb(
					'Clan lookup failed, deferring cleanup to be safe',
					{ error: String(error), customRoleId },
					'error',
				);
				captureError(error as Error, 'cleanupPremiumMember: getClan failed', { guildId, userId, customRoleId });
				this.container.logger.warn(
					`${LOG_PREFIX} [CLEANUP] Clan lookup failed for role ${customRoleId} (owner ${userId}); deferring cleanup to avoid data loss`,
				);
				return 'skipped';
			}

			if (clan) {
				if (clan.deletionTaskId) {
					this.container.logger.info(
						`${LOG_PREFIX} [CLEANUP] Clan for role ${customRoleId} is already orphaned (task ${clan.deletionTaskId}); preserving premium entry + gift for the grace period`,
					);
					addBreadcrumb('Clan already orphaned, deferring cleanup to grace period', {
						customRoleId,
						deletionTaskId: clan.deletionTaskId,
					});
					return 'skipped';
				}

				// Clan exists but has no grace period yet (e.g. the owner left while the bot was offline,
				// so the live leave listener never orphaned it). Start the grace period now and keep the
				// premium entry + gift intact so the owner can still be restored if they come back.
				try {
					addBreadcrumb('Clan found without grace period, orphaning it now', { customRoleId });
					await clanManager.makeClanOrphan();
					this.container.logger.info(
						`${LOG_PREFIX} [CLEANUP] Clan for role ${customRoleId} (owner ${userId}) had no grace period; orphaned it now and preserved premium entry + gift`,
					);
					addBreadcrumb('Clan orphaned during cleanup, premium entry preserved', { customRoleId, userId });
					return 'orphaned';
				} catch (error) {
					addBreadcrumb(
						'Failed to orphan clan during cleanup, deferring',
						{ error: String(error), customRoleId },
						'error',
					);
					captureError(error as Error, 'cleanupPremiumMember: makeClanOrphan failed', {
						guildId,
						userId,
						customRoleId,
					});
					this.container.logger.error(
						`${LOG_PREFIX} [CLEANUP] Failed to orphan clan for role ${customRoleId} (owner ${userId}); deferring cleanup`,
						error,
					);
					return 'skipped';
				}
			}

			// customRoleId is set but there's no clan record: this is a standalone custom role with no
			// clan to protect, so it's safe to delete the Discord role right away.
			addBreadcrumb('No clan for role, deleting standalone custom role', { customRoleId });
			let role;
			try {
				role = await guild.roles.fetch(customRoleId);
				addBreadcrumb('Role fetch completed', { found: Boolean(role), customRoleId });
			} catch (error) {
				addBreadcrumb('Role fetch failed (may not exist)', { error: String(error), customRoleId }, 'warning');
				role = null;
			}

			if (role) {
				try {
					addBreadcrumb('Deleting custom role', { customRoleId, roleName: role.name });
					await role.delete(`Premium member ${reason}: user ${userId} lost abilities`);
					this.container.logger.info(
						`${LOG_PREFIX} [CLEANUP] Deleted standalone custom role ${customRoleId} for ${reason} user ${userId}`,
					);
					addBreadcrumb('Custom role deleted successfully', { customRoleId, userId });
				} catch (error) {
					this.container.logger.error(
						`${LOG_PREFIX} [CLEANUP] Failed to delete custom role ${customRoleId}:`,
						error,
					);
					addBreadcrumb('Failed to delete custom role', { error: String(error), customRoleId }, 'error');
					captureError(error as Error, 'cleanupPremiumMember: role delete failed', {
						guildId,
						userId,
						customRoleId,
					});
				}
			}
		}

		// Remove the gifted Legend role (if any) before the DB row tracking it disappears
		if (premiumMember.giftedRoleToUserId) {
			addBreadcrumb('Removing gifted Legend role', {
				guildId,
				userId,
				giftedToUserId: premiumMember.giftedRoleToUserId,
			});
			try {
				await ClanManager.deleteGiftedRole(premiumMember);
				this.container.logger.info(
					`${LOG_PREFIX} [CLEANUP] Revoked gifted Legend role from ${reason} member ${userId} (was gifted to ${premiumMember.giftedRoleToUserId})`,
				);
				addBreadcrumb('Gifted Legend role removed', { guildId, userId });
			} catch (error) {
				this.container.logger.error(
					`${LOG_PREFIX} [CLEANUP] Failed to remove gifted Legend role for ${reason} user ${userId}:`,
					error,
				);
				addBreadcrumb(
					'Failed to remove gifted Legend role',
					{ error: String(error), guildId, userId },
					'error',
				);
				captureError(error as Error, 'cleanupPremiumMember: deleteGiftedRole failed', {
					guildId,
					userId,
					giftedToUserId: premiumMember.giftedRoleToUserId,
				});
			}
		}

		// No clan to protect, so remove the premium member entry for good.
		addBreadcrumb('Deleting premium member from database', { guildId, userId });
		try {
			await this.container.prisma.premiumMember.delete({
				where: {
					guildId_userId: {
						guildId,
						userId,
					},
				},
			});

			this.container.logger.info(
				`${LOG_PREFIX} [FIXED] Removed premium member entry for ${reason} user ${userId} in guild ${guildName} (${guildId})`,
			);
			addBreadcrumb('Premium member database entry deleted', { guildId, userId, reason });
		} catch (error) {
			this.container.logger.error(
				`${LOG_PREFIX} Failed to remove premium member ${userId} in guild ${guildId}:`,
				error,
			);
			addBreadcrumb(
				'Failed to delete premium member from database',
				{ error: String(error), guildId, userId },
				'error',
			);
			captureError(error as Error, 'cleanupPremiumMember: database delete failed', { guildId, userId });
		}

		addBreadcrumb('cleanupPremiumMember completed', { guildId, userId, reason });
		return 'deleted';
	}

	public async checkAbilities(
		options: CheckPremiumMemberAbilitiesOptions = {},
	): Promise<CheckPremiumMemberAbilitiesResult> {
		const fixMode = options.fixMode ?? 'dry-run';
		this.container.logger.info(`${LOG_PREFIX} Starting premium member ability check (mode: ${fixMode})...`);
		addBreadcrumb('checkAbilities started', { fixMode, guildId: options.guildId ?? 'all' });

		const whereClause = options.guildId ? { guildId: options.guildId } : {};

		addBreadcrumb('Querying premium members from database', { whereClause });
		let premiumMembers;
		try {
			premiumMembers = await this.container.prisma.premiumMember.findMany({
				where: whereClause,
			});
			addBreadcrumb('Premium members query completed', { count: premiumMembers.length });
			this.container.logger.info(`${LOG_PREFIX} Found ${premiumMembers.length} premium members to check`);
		} catch (error) {
			addBreadcrumb('Premium members query FAILED', { error: String(error) }, 'error');
			captureError(error as Error, 'checkAbilities: premiumMember.findMany failed');
			this.container.logger.error(`${LOG_PREFIX} Failed to query premium members:`, error);
			return {
				totalChecked: 0,
				totalMismatches: 0,
				totalMissing: 0,
				fixed: 0,
				totalOrphanedClansWithoutTask: 0,
				orphanedClansFixed: 0,
				totalStaleGifts: 0,
				staleGiftsFixed: 0,
				totalStrayPickUsers: 0,
				strayPickUsersFixed: 0,
			};
		}

		let totalChecked = 0;
		let totalMismatches = 0;
		let totalMissing = 0;
		let fixed = 0;
		let totalOrphanedClansWithoutTask = 0;
		let orphanedClansFixed = 0;
		let totalStaleGifts = 0;
		let staleGiftsFixed = 0;

		if (premiumMembers.length > 0) {
			addBreadcrumb('Starting premium member iteration', { totalMembers: premiumMembers.length });

			for (const [index, premiumMember] of premiumMembers.entries()) {
				if (index % 10 === 0) {
					addBreadcrumb('Processing premium members', {
						progress: `${index}/${premiumMembers.length}`,
						totalChecked,
						totalMismatches,
						totalMissing,
					});
				}

				try {
					const guild = this.container.client.guilds.resolve(premiumMember.guildId);

					if (!guild) {
						this.container.logger.warn(
							`${LOG_PREFIX} Guild ${premiumMember.guildId} not found for user ${premiumMember.userId}`,
						);
						addBreadcrumb(
							'Guild not found for premium member',
							{ guildId: premiumMember.guildId, userId: premiumMember.userId },
							'warning',
						);
						continue;
					}

					totalChecked++;

					let member;

					try {
						addBreadcrumb('Fetching guild member', { guildId: guild.id, userId: premiumMember.userId });
						member = await guild.members.fetch(premiumMember.userId);
						addBreadcrumb('Guild member fetched', {
							guildId: guild.id,
							userId: premiumMember.userId,
							tag: member.user.tag,
						});
					} catch (fetchError) {
						totalMissing++;
						this.container.logger.warn(
							`${LOG_PREFIX} User ${premiumMember.userId} not found in guild ${guild.name} (${guild.id}) - may have left the server`,
						);
						addBreadcrumb(
							'Member not found in guild (may have left)',
							{ guildId: guild.id, userId: premiumMember.userId, error: String(fetchError) },
							'warning',
						);

						// Fix missing members if mode is 'fix-missing' or 'fix-all'
						if (fixMode === 'fix-missing' || fixMode === 'fix-all') {
							addBreadcrumb('Cleaning up missing member', { userId: premiumMember.userId, fixMode });
							const outcome = await this.cleanupPremiumMember(premiumMember, guild.name, 'missing');

							if (outcome === 'deleted') {
								fixed++;

								if (premiumMember.giftedRoleToUserId) {
									staleGiftsFixed++;
								}
							} else if (outcome === 'orphaned') {
								orphanedClansFixed++;
							}
						}

						if (premiumMember.giftedRoleToUserId) {
							totalStaleGifts++;
						}

						continue;
					}

					addBreadcrumb('Computing member abilities', { userId: premiumMember.userId, tag: member.user.tag });
					const memberAbilities = new MemberAbilities(member);

					try {
						await memberAbilities.computeAbilities();
						addBreadcrumb('Abilities computed', { userId: premiumMember.userId });
					} catch (abilityError) {
						addBreadcrumb(
							'Failed to compute abilities',
							{ userId: premiumMember.userId, error: String(abilityError) },
							'error',
						);
						captureError(abilityError as Error, 'checkAbilities: computeAbilities failed', {
							userId: premiumMember.userId,
							guildId: premiumMember.guildId,
						});
						continue;
					}

					const hasAnyAbility =
						memberAbilities.hasAbility('canCreateClan') ||
						memberAbilities.hasAbility('canCreateCustomRole') ||
						memberAbilities.hasAbility('canGiftLegend') ||
						memberAbilities.hasAbility('areAbilitiesMultiGuild') ||
						memberAbilities.hasAbility('canUploadCustomEmoji') ||
						memberAbilities.hasAbility('canPickSubscriberRole');

					addBreadcrumb('Ability check result', {
						userId: premiumMember.userId,
						hasAnyAbility,
						canCreateClan: memberAbilities.hasAbility('canCreateClan'),
						canCreateCustomRole: memberAbilities.hasAbility('canCreateCustomRole'),
						canGiftLegend: memberAbilities.hasAbility('canGiftLegend'),
						areAbilitiesMultiGuild: memberAbilities.hasAbility('areAbilitiesMultiGuild'),
						canUploadCustomEmoji: memberAbilities.hasAbility('canUploadCustomEmoji'),
						canPickSubscriberRole: memberAbilities.hasAbility('canPickSubscriberRole'),
					});

					if (!hasAnyAbility) {
						totalMismatches++;
						this.container.logger.warn(
							`${LOG_PREFIX} [PREMIUM MEMBER LOST ABILITIES] User ${member.user.tag} (${premiumMember.userId}) in guild ${guild.name} (${guild.id}) is in the premium members database but has NO premium abilities in Discord. This indicates they lost their premium role.`,
							{
								userId: premiumMember.userId,
								guildId: premiumMember.guildId,
								guildName: guild.name,
								userTag: member.user.tag,
								customRoleId: premiumMember.customRoleId,
							},
						);
						addBreadcrumb(
							'MISMATCH: Premium member has no abilities',
							{
								userId: premiumMember.userId,
								guildId: premiumMember.guildId,
								tag: member.user.tag,
								customRoleId: premiumMember.customRoleId,
							},
							'warning',
						);
						captureWarning(`Premium member lost abilities: ${member.user.tag} (${premiumMember.userId})`, {
							userId: premiumMember.userId,
							guildId: premiumMember.guildId,
							customRoleId: premiumMember.customRoleId,
						});

						// Fix mismatches if mode is 'fix-mismatches' or 'fix-all'
						if (fixMode === 'fix-mismatches' || fixMode === 'fix-all') {
							addBreadcrumb('Cleaning up mismatch member', { userId: premiumMember.userId, fixMode });
							const outcome = await this.cleanupPremiumMember(premiumMember, guild.name, 'mismatch');

							if (outcome === 'deleted') {
								fixed++;

								if (premiumMember.giftedRoleToUserId) {
									staleGiftsFixed++;
								}
							} else if (outcome === 'orphaned') {
								orphanedClansFixed++;
							}
						}
					}

					// Member still has an active gift but lost canGiftLegend (e.g. role changed while
					// the bot was offline, or they kept other premium abilities)
					if (premiumMember.giftedRoleToUserId && !memberAbilities.hasAbility('canGiftLegend')) {
						totalStaleGifts++;

						this.container.logger.warn(
							`${LOG_PREFIX} [STALE GIFT] User ${member.user.tag} (${premiumMember.userId}) in guild ${guild.name} (${guild.id}) has an active Legend gift to ${premiumMember.giftedRoleToUserId} but no canGiftLegend ability.`,
						);
						addBreadcrumb(
							'STALE GIFT detected',
							{
								userId: premiumMember.userId,
								guildId: premiumMember.guildId,
								giftedToUserId: premiumMember.giftedRoleToUserId,
							},
							'warning',
						);
						captureWarning(`Stale Legend gift: ${member.user.tag} (${premiumMember.userId})`, {
							userId: premiumMember.userId,
							guildId: premiumMember.guildId,
							giftedToUserId: premiumMember.giftedRoleToUserId,
						});

						// When the member has no abilities at all, the mismatch cleanup above already revoked
						// the gift - only revoke here for members who kept other premium abilities
						if (hasAnyAbility && (fixMode === 'fix-mismatches' || fixMode === 'fix-all')) {
							try {
								addBreadcrumb('Revoking stale Legend gift', { userId: premiumMember.userId });
								await ClanManager.deleteGiftedRole(premiumMember);
								staleGiftsFixed++;
								this.container.logger.info(
									`${LOG_PREFIX} [FIXED] Revoked stale Legend gift from ${premiumMember.userId} to ${premiumMember.giftedRoleToUserId} in guild ${guild.name} (${guild.id})`,
								);
								addBreadcrumb('Stale Legend gift revoked', { userId: premiumMember.userId });
							} catch (error) {
								addBreadcrumb(
									'Failed to revoke stale Legend gift',
									{ userId: premiumMember.userId, error: String(error) },
									'error',
								);
								captureError(error as Error, 'checkAbilities: deleteGiftedRole for stale gift failed', {
									userId: premiumMember.userId,
									guildId: premiumMember.guildId,
								});
							}
						}
					}
				} catch (error) {
					this.container.logger.error(
						`${LOG_PREFIX} Error checking premium member ${premiumMember.userId} in guild ${premiumMember.guildId}:`,
						error,
					);
					addBreadcrumb(
						'Error checking premium member',
						{ userId: premiumMember.userId, guildId: premiumMember.guildId, error: String(error) },
						'error',
					);
					captureError(error as Error, 'checkAbilities: error in premium member loop', {
						userId: premiumMember.userId,
						guildId: premiumMember.guildId,
					});
				}
			}

			addBreadcrumb('Premium member iteration completed', {
				totalChecked,
				totalMismatches,
				totalMissing,
				fixed,
			});
		} else {
			addBreadcrumb('No premium members found to check', { whereClause });
			this.container.logger.info(`${LOG_PREFIX} No premium members found to check`);
		}

		// Check all clans for orphan issues
		this.container.logger.info(`${LOG_PREFIX} Checking for orphaned clans...`);
		addBreadcrumb('Starting orphaned clan check');

		let clans: { customRoleId: string; deletionTaskId: number | null; guildId: string }[] = [];
		try {
			addBreadcrumb('Querying clans from database');
			clans = await this.container.prisma.clan.findMany({
				where: options.guildId ? { guildId: options.guildId } : {},
				select: {
					customRoleId: true,
					deletionTaskId: true,
					guildId: true,
				},
			});
			addBreadcrumb('Clans query completed', { count: clans.length });
			this.container.logger.info(`${LOG_PREFIX} Found ${clans.length} clans to check`);
		} catch (error) {
			addBreadcrumb('Clans query FAILED', { error: String(error) }, 'error');
			captureError(error as Error, 'checkAbilities: clan.findMany failed');
			this.container.logger.error(`${LOG_PREFIX} Failed to query clans:`, error);
		}

		for (const [index, clan] of clans.entries()) {
			if (index % 10 === 0) {
				addBreadcrumb('Processing clans', {
					progress: `${index}/${clans.length}`,
					totalOrphanedClansWithoutTask,
					orphanedClansFixed,
				});
			}

			try {
				let isOrphaned = false;
				let orphanReason = '';

				if (clan.deletionTaskId) {
					// Clan has a deletionTaskId, verify the scheduled task actually exists
					addBreadcrumb('Verifying scheduled deletion task exists', {
						customRoleId: clan.customRoleId,
						deletionTaskId: clan.deletionTaskId,
					});

					let scheduledTask;
					try {
						scheduledTask = await this.container.prisma.schedule.findUnique({
							where: { id: clan.deletionTaskId },
						});
						addBreadcrumb('Scheduled task lookup completed', {
							customRoleId: clan.customRoleId,
							taskExists: Boolean(scheduledTask),
						});
					} catch (error) {
						addBreadcrumb(
							'Scheduled task lookup failed',
							{ customRoleId: clan.customRoleId, error: String(error) },
							'error',
						);
						captureError(error as Error, 'checkAbilities: schedule lookup failed', {
							customRoleId: clan.customRoleId,
							deletionTaskId: clan.deletionTaskId,
						});
					}

					if (!scheduledTask) {
						isOrphaned = true;
						orphanReason = `has deletionTaskId ${clan.deletionTaskId} but no scheduled task exists`;
					}
				} else {
					// Clan has no deletionTaskId, check if it has a premium member owner
					addBreadcrumb('Checking for premium member owner', { customRoleId: clan.customRoleId });

					let premiumMember;
					try {
						premiumMember = await this.container.prisma.premiumMember.findFirst({
							where: {
								guildId: clan.guildId,
								customRoleId: clan.customRoleId,
							},
						});
						addBreadcrumb('Premium member owner lookup completed', {
							customRoleId: clan.customRoleId,
							found: Boolean(premiumMember),
						});
					} catch (error) {
						addBreadcrumb(
							'Premium member owner lookup failed',
							{ customRoleId: clan.customRoleId, error: String(error) },
							'error',
						);
						captureError(error as Error, 'checkAbilities: premiumMember lookup for clan failed', {
							customRoleId: clan.customRoleId,
							guildId: clan.guildId,
						});
					}

					if (!premiumMember) {
						isOrphaned = true;
						orphanReason = 'has no premium member entry and no deletionTaskId';
					}
				}

				if (isOrphaned) {
					totalOrphanedClansWithoutTask++;

					this.container.logger.warn(
						`${LOG_PREFIX} [ORPHANED CLAN] Clan with custom role ${clan.customRoleId} in guild ${clan.guildId} ${orphanReason}`,
					);
					addBreadcrumb(
						'ORPHANED CLAN detected',
						{ customRoleId: clan.customRoleId, guildId: clan.guildId, reason: orphanReason },
						'warning',
					);
					captureWarning(`Orphaned clan detected: ${clan.customRoleId}`, {
						customRoleId: clan.customRoleId,
						guildId: clan.guildId,
						reason: orphanReason,
					});

					// Schedule orphaned clan for deletion with a grace period
					if (fixMode === 'fix-all' || fixMode === 'fix-missing') {
						try {
							addBreadcrumb('Scheduling orphaned clan for deletion', {
								customRoleId: clan.customRoleId,
							});

							const deletionDate = new Duration('1 week').fromNow;
							const deletionTask = await this.container.client.schedule.add(
								'deleteOrphanClan',
								deletionDate,
								JSON.stringify({ customRoleId: clan.customRoleId, guildId: clan.guildId }),
							);

							await this.container.prisma.clan.update({
								where: {
									guildId_customRoleId: {
										guildId: clan.guildId,
										customRoleId: clan.customRoleId,
									},
								},
								data: { deletionTaskId: deletionTask.id },
							});

							orphanedClansFixed++;
							this.container.logger.info(
								`${LOG_PREFIX} [FIXED] Scheduled orphaned clan ${clan.customRoleId} in guild ${clan.guildId} for deletion in 1 week (task ${deletionTask.id})`,
							);
							addBreadcrumb('Orphaned clan scheduled for deletion', {
								customRoleId: clan.customRoleId,
								guildId: clan.guildId,
								taskId: deletionTask.id,
								deletionDate: deletionDate.toISOString(),
							});
						} catch (error) {
							this.container.logger.error(
								`${LOG_PREFIX} Failed to schedule orphaned clan ${clan.customRoleId} in guild ${clan.guildId} for deletion:`,
								error,
							);
							addBreadcrumb(
								'Failed to schedule orphaned clan for deletion',
								{ customRoleId: clan.customRoleId, error: String(error) },
								'error',
							);
							captureError(error as Error, 'checkAbilities: orphaned clan scheduling failed', {
								customRoleId: clan.customRoleId,
								guildId: clan.guildId,
							});
						}
					}
				}
			} catch (error) {
				this.container.logger.error(
					`${LOG_PREFIX} Error checking clan ${clan.customRoleId} in guild ${clan.guildId}:`,
					error,
				);
				addBreadcrumb(
					'Error checking clan',
					{ customRoleId: clan.customRoleId, guildId: clan.guildId, error: String(error) },
					'error',
				);
				captureError(error as Error, 'checkAbilities: error in clan loop', {
					customRoleId: clan.customRoleId,
					guildId: clan.guildId,
				});
			}
		}

		addBreadcrumb('Clan iteration completed', { totalOrphanedClansWithoutTask, orphanedClansFixed });

		// Catch members who picked perk roles via /pick-role but no longer have canPickSubscriberRole
		// (e.g. premium revoked while bot was offline). Listener-based stripping covers the live case;
		// this is the periodic safety net.
		this.container.logger.info(`${LOG_PREFIX} Checking for stray subscriber pickable roles...`);
		addBreadcrumb('Starting stray pickable role check');

		let totalStrayPickUsers = 0;
		let strayPickUsersFixed = 0;

		let pickableConfigs: { guildId: string; pickableRoleIds: string[] }[] = [];
		try {
			pickableConfigs = await this.container.prisma.premiumGuildRoleConfig.findMany({
				where: options.guildId ? { guildId: options.guildId } : {},
				select: { guildId: true, pickableRoleIds: true },
			});
			addBreadcrumb('Pickable configs query completed', { count: pickableConfigs.length });
		} catch (error) {
			addBreadcrumb('Pickable configs query FAILED', { error: String(error) }, 'error');
			captureError(error as Error, 'checkAbilities: premiumGuildRoleConfig.findMany failed');
		}

		for (const config of pickableConfigs) {
			if (config.pickableRoleIds.length === 0) {
				continue;
			}

			const guild = this.container.client.guilds.resolve(config.guildId);
			if (!guild) {
				addBreadcrumb('Guild not found for pickable config', { guildId: config.guildId }, 'warning');
				continue;
			}

			try {
				addBreadcrumb('Fetching all members for pickable check', { guildId: config.guildId });
				await guild.members.fetch();
			} catch (error) {
				addBreadcrumb(
					'Failed to fetch members for pickable check',
					{ guildId: config.guildId, error: String(error) },
					'error',
				);
				captureError(error as Error, 'checkAbilities: members.fetch for pickable check failed', {
					guildId: config.guildId,
				});
				continue;
			}

			const candidateIds = new Set<string>();
			for (const roleId of config.pickableRoleIds) {
				const role = guild.roles.cache.get(roleId);
				if (!role) {
					continue;
				}

				for (const memberId of role.members.keys()) {
					candidateIds.add(memberId);
				}
			}

			addBreadcrumb('Candidates with pickable roles identified', {
				guildId: config.guildId,
				candidateCount: candidateIds.size,
			});

			for (const userId of candidateIds) {
				const member = guild.members.cache.get(userId);
				if (!member) {
					continue;
				}

				const memberAbilities = new MemberAbilities(member);

				try {
					await memberAbilities.computeAbilities();
				} catch (abilityError) {
					addBreadcrumb(
						'Failed to compute abilities for stray pick check',
						{ userId, guildId: config.guildId, error: String(abilityError) },
						'error',
					);
					captureError(abilityError as Error, 'checkAbilities: computeAbilities for stray pick failed', {
						userId,
						guildId: config.guildId,
					});
					continue;
				}

				if (memberAbilities.hasAbility('canPickSubscriberRole')) {
					continue;
				}

				const strayRoles = config.pickableRoleIds.filter((roleId) => member.roles.cache.has(roleId));
				if (strayRoles.length === 0) {
					continue;
				}

				totalStrayPickUsers++;

				this.container.logger.warn(
					`${LOG_PREFIX} [STRAY PICKS] User ${member.user.tag} (${userId}) in guild ${guild.name} (${guild.id}) has ${strayRoles.length} pickable role(s) but no canPickSubscriberRole ability.`,
				);
				addBreadcrumb('STRAY PICKS detected', { userId, guildId: config.guildId, strayRoles }, 'warning');
				captureWarning(`Stray subscriber picks: ${member.user.tag} (${userId})`, {
					userId,
					guildId: config.guildId,
					strayRoles,
				});

				if (fixMode === 'fix-mismatches' || fixMode === 'fix-all') {
					let allRolesRemoved = true;

					for (const roleId of strayRoles) {
						try {
							await member.roles.remove(
								roleId,
								'Stray subscriber pick: lost canPickSubscriberRole (reconciler)',
							);
						} catch (error) {
							allRolesRemoved = false;
							addBreadcrumb(
								'Failed to remove stray pickable role',
								{ userId, guildId: config.guildId, roleId, error: String(error) },
								'error',
							);
							captureError(error as Error, 'checkAbilities: remove stray pickable role failed', {
								userId,
								guildId: config.guildId,
								roleId,
							});
						}
					}

					if (allRolesRemoved) {
						strayPickUsersFixed++;
					}
				}
			}
		}

		addBreadcrumb('Stray pickable role check completed', { totalStrayPickUsers, strayPickUsersFixed });

		// NOTE: Do NOT sweep Legend role holders without a gift entry - the role is also granted
		// externally to Stripe subscribers, which the bot has no way to identify. Stale gifts are
		// only detectable through the giftedRoleToUserId entries handled above.

		const summary = `Checked ${totalChecked} members, found ${totalMismatches} mismatches, ${totalMissing} missing${totalOrphanedClansWithoutTask > 0 ? `, ${totalOrphanedClansWithoutTask} orphaned clans` : ''}${totalStaleGifts > 0 ? `, ${totalStaleGifts} stale Legend gifts` : ''}${totalStrayPickUsers > 0 ? `, ${totalStrayPickUsers} stray pick users` : ''}${fixMode === 'dry-run' ? '' : `, fixed ${fixed} members, scheduled ${orphanedClansFixed} orphaned clans for deletion, revoked ${staleGiftsFixed} stale Legend gifts, and stripped picks from ${strayPickUsersFixed} users`}.`;

		this.container.logger.info(`${LOG_PREFIX} Completed. ${summary}`);
		addBreadcrumb('checkAbilities completed', {
			totalChecked,
			totalMismatches,
			totalMissing,
			fixed,
			totalOrphanedClansWithoutTask,
			orphanedClansFixed,
			totalStaleGifts,
			staleGiftsFixed,
			totalStrayPickUsers,
			strayPickUsersFixed,
			fixMode,
		});

		return {
			totalChecked,
			totalMismatches,
			totalMissing,
			fixed,
			totalOrphanedClansWithoutTask,
			orphanedClansFixed,
			totalStaleGifts,
			staleGiftsFixed,
			totalStrayPickUsers,
			strayPickUsersFixed,
		};
	}
}
