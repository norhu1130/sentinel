import type { ClanEventType, Prisma } from '@prisma/client';
import { container } from '@sapphire/framework';
import * as Sentry from '@sentry/node';
import { LogPrefix } from './logPrefix.js';

export interface ClanEventInput {
	/**
	 * Who triggered the event (a user id), or null/undefined for system/scheduled actions.
	 */
	actorUserId?: string | null;
	/**
	 * Snapshot of the clan/role name at event time, for readability after deletion.
	 */
	clanName?: string | null;
	/**
	 * The clan's stable identity (its custom role id).
	 */
	customRoleId: string;
	eventType: ClanEventType;
	guildId: string;
	/**
	 * Structured extras (channelId, taskId, old/new values, deletionDate, backfilled, ...).
	 */
	metadata?: Prisma.InputJsonValue;
	/**
	 * The clan owner's user id at event time.
	 */
	ownerUserId?: string | null;
	/**
	 * Human-readable explanation of why the event happened.
	 */
	reason?: string | null;
	/**
	 * The member affected by the event (joins, kicks, transfers, gifts), if any.
	 */
	targetUserId?: string | null;
}

/**
 * Best-effort append to a clan's persistent audit history. This NEVER throws — recording history
 * must not be able to break the clan operation it is describing. Failures are logged and reported
 * to Sentry, then swallowed.
 */
export async function recordClanEvent(event: ClanEventInput): Promise<void> {
	try {
		await container.prisma.clanHistoryEvent.create({
			data: {
				guildId: event.guildId,
				customRoleId: event.customRoleId,
				eventType: event.eventType,
				clanName: event.clanName ?? null,
				ownerUserId: event.ownerUserId ?? null,
				actorUserId: event.actorUserId ?? null,
				targetUserId: event.targetUserId ?? null,
				reason: event.reason ?? null,
				metadata: event.metadata,
			},
		});
	} catch (error) {
		container.logger.warn(`${LogPrefix.CLAN} Failed to record clan history event`, {
			guildId: event.guildId,
			customRoleId: event.customRoleId,
			eventType: event.eventType,
			error,
		});
		Sentry.withScope((scope) => {
			scope.setTag('operation', 'recordClanEvent');
			scope.setTag('eventType', event.eventType);
			scope.setExtras({ guildId: event.guildId, customRoleId: event.customRoleId });
			Sentry.captureException(error);
		});
	}
}
