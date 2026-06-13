import { Buffer } from 'node:buffer';
import type { Clan } from '@prisma/client';
import { container } from '@sapphire/framework';
import type { GuildMember } from 'discord.js';
import { ClanManager } from '../../lib/abilities/ClanManager.js';
import { LogPrefix } from '../../lib/utils/logPrefix.js';

/**
 * The prefix that triggers a custom command in chat, e.g. `!cat`.
 */
export const CUSTOM_COMMAND_PREFIX = '!';

/**
 * Command names: 1-32 chars, lowercase letters/numbers/dashes/underscores.
 */
export const CUSTOM_COMMAND_NAME_REGEX = /^[\d_a-z-]{1,32}$/;

/**
 * Maximum number of custom commands a single clan may own.
 */
export const MAX_CUSTOM_COMMANDS_PER_CLAN = 25;

/**
 * Uploaded media is stored as bytea; keep it small so the database stays healthy.
 */
export const CUSTOM_COMMAND_MEDIA_MAX_BYTES = 4 * 1_024 * 1_024;

/**
 * Allowed uploaded media types, keyed by the lowercased file extension.
 */
export const ALLOWED_MEDIA_EXTENSIONS: Readonly<Record<string, string>> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	mp4: 'video/mp4',
	webm: 'video/webm',
};

/**
 * Anti-spam: a user may trigger at most this many custom commands per window.
 */
export const RATE_LIMIT_MAX = 3;
export const RATE_LIMIT_WINDOW_MS = 5_000;

const rateLimitBuckets = new Map<string, number[]>();

/**
 * Sliding-window rate limiter for custom command triggers. Returns true when the caller has
 * exceeded {@link RATE_LIMIT_MAX} triggers within {@link RATE_LIMIT_WINDOW_MS}; otherwise records
 * this trigger and returns false. Keyed per guild + user.
 */
export function isRateLimited(guildId: string, userId: string): boolean {
	const key = `${guildId}:${userId}`;
	const now = Date.now();
	const recent = (rateLimitBuckets.get(key) ?? []).filter((timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS);

	if (recent.length >= RATE_LIMIT_MAX) {
		rateLimitBuckets.set(key, recent);
		return true;
	}

	recent.push(now);
	rateLimitBuckets.set(key, recent);
	return false;
}

export type CustomCommandInputMode = 'both' | 'upload' | 'url';

export function isCustomCommandInputMode(value: string): value is CustomCommandInputMode {
	return value === 'upload' || value === 'url' || value === 'both';
}

export function normalizeCommandName(raw: string): string {
	return raw
		.trim()
		.toLowerCase()
		.replace(new RegExp(`^\\${CUSTOM_COMMAND_PREFIX}+`), '');
}

export function isValidCommandName(name: string): boolean {
	return CUSTOM_COMMAND_NAME_REGEX.test(name);
}

/**
 * Resolves the clan owned by this member (the clan their commands belong to), if any.
 */
export async function getOwnedClan(member: GuildMember): Promise<Clan | null | undefined> {
	const clanManager = new ClanManager(member);
	return clanManager.getClan();
}

/**
 * Reads the guild's configured media input mode, defaulting to "upload".
 */
export async function getInputMode(guildId: string): Promise<CustomCommandInputMode> {
	const config = await container.prisma.premiumGuildRoleConfig.findFirst({
		where: { guildId },
		select: { customCommandInputMode: true },
	});

	const mode = config?.customCommandInputMode;
	return mode && isCustomCommandInputMode(mode) ? mode : 'upload';
}

/**
 * Node's global fetch has no default timeout, so a stalled CDN connection would hang forever.
 */
export const MEDIA_FETCH_TIMEOUT_MS = 15_000;

export async function fetchMediaBuffer(url: string, timeoutMs = MEDIA_FETCH_TIMEOUT_MS): Promise<Buffer | null> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });

		if (!res.ok) {
			container.logger.warn(`${LogPrefix.CUSTOM_COMMAND} fetchMediaBuffer: non-ok response`, {
				url,
				status: res.status,
				statusText: res.statusText,
			});
			return null;
		}

		return Buffer.from(await res.arrayBuffer());
	} catch (error) {
		container.logger.warn(`${LogPrefix.CUSTOM_COMMAND} fetchMediaBuffer: download failed`, {
			url,
			error: String(error),
		});
		return null;
	}
}

export function isValidHttpUrl(value: string): boolean {
	let url: URL;

	try {
		url = new URL(value);
	} catch {
		return false;
	}

	return url.protocol === 'http:' || url.protocol === 'https:';
}
