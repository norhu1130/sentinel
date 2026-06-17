import { Buffer } from 'node:buffer';
import { setInterval } from 'node:timers';
import type { Clan } from '@prisma/client';
import { container } from '@sapphire/framework';
import { AutoModerationRuleTriggerType, type Guild, type GuildMember } from 'discord.js';
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

/**
 * How often expired rate-limit buckets are swept from memory. Without this, every unique
 * (guild, user) pair that ever triggered a command would keep its bucket forever, leaking
 * memory over the lifetime of the process.
 */
export const RATE_LIMIT_SWEEP_INTERVAL_MS = 60_000;

const rateLimitBuckets = new Map<string, number[]>();

// Drop buckets whose timestamps have all aged out. Active buckets keep getting trimmed on
// access in isRateLimited; this only reclaims the ones for users who never come back.
setInterval(() => {
	const now = Date.now();
	for (const [key, timestamps] of rateLimitBuckets) {
		if (timestamps.every((timestamp) => now - timestamp >= RATE_LIMIT_WINDOW_MS)) {
			rateLimitBuckets.delete(key);
		}
	}
}, RATE_LIMIT_SWEEP_INTERVAL_MS).unref();

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

/**
 * Describes why a piece of content was rejected by an AutoMod rule.
 */
export interface AutoModViolation {
	/**
	 * The substring of the content that triggered the rule.
	 */
	match: string;
	/**
	 * The name of the AutoMod rule that matched.
	 */
	ruleName: string;
}

/**
 * Escapes a string so it can be embedded literally inside a RegExp.
 */
function escapeRegex(value: string): string {
	return value.replaceAll(/[$()*+.?[\\\]^{|}]/g, '\\$&');
}

/**
 * Converts a single Discord AutoMod keyword-filter / allow-list entry into a RegExp, mirroring
 * Discord's wildcard semantics:
 *   - `word`   matches the whole word only (bounded by non-alphanumeric characters)
 *   - `word*`  matches a word starting with `word` (prefix)
 *   - `*word`  matches a word ending with `word` (suffix)
 *   - `*word*` matches the substring anywhere
 * Internal `*` are treated as "any characters". Matching is case-insensitive. Returns null for an
 * entry that is empty once its wildcards are stripped.
 */
function keywordToRegex(keyword: string): RegExp | null {
	const leadingWildcard = keyword.startsWith('*');
	const trailingWildcard = keyword.endsWith('*');
	const core = keyword.replace(/^\*+/, '').replace(/\*+$/, '');

	if (!core) {
		return null;
	}

	const body = core.split('*').map(escapeRegex).join('.*');
	const left = leadingWildcard ? '' : '(?<![\\p{L}\\p{N}])';
	const right = trailingWildcard ? '' : '(?![\\p{L}\\p{N}])';

	try {
		return new RegExp(`${left}${body}${right}`, 'iu');
	} catch {
		return null;
	}
}

/**
 * Checks `content` against the guild's enabled keyword-based AutoMod rules and returns the first
 * violation found, or null when the content is clean.
 *
 * Only `Keyword` rules can be evaluated here: `KeywordPreset` rules rely on Discord's private word
 * lists, and Spam / MentionSpam aren't content filters, so those are skipped. If the rules can't be
 * fetched (e.g. the bot lacks Manage Server), this returns null rather than blocking creation — the
 * live AutoMod still applies when the command is actually triggered as a backstop.
 */
export async function findAutoModViolation(guild: Guild, content: string): Promise<AutoModViolation | null> {
	const trimmed = content.trim();

	if (!trimmed) {
		return null;
	}

	let rules;

	try {
		rules = await guild.autoModerationRules.fetch();
	} catch (error) {
		container.logger.warn(`${LogPrefix.CUSTOM_COMMAND} findAutoModViolation: failed to fetch rules`, {
			guildId: guild.id,
			error: String(error),
		});
		return null;
	}

	for (const rule of rules.values()) {
		if (!rule.enabled || rule.triggerType !== AutoModerationRuleTriggerType.Keyword) {
			continue;
		}

		const allowMatchers = (rule.triggerMetadata.allowList ?? [])
			.map(keywordToRegex)
			.filter((regex): regex is RegExp => regex !== null);

		const matchers: RegExp[] = [];

		for (const keyword of rule.triggerMetadata.keywordFilter ?? []) {
			const regex = keywordToRegex(keyword);
			if (regex) {
				matchers.push(regex);
			}
		}

		for (const pattern of rule.triggerMetadata.regexPatterns ?? []) {
			try {
				matchers.push(new RegExp(pattern, 'iu'));
			} catch {
				// skip patterns JS can't compile.
			}
		}

		for (const regex of matchers) {
			const found = regex.exec(trimmed);
			if (found && !allowMatchers.some((allow) => allow.test(found[0]))) {
				return { ruleName: rule.name, match: found[0] };
			}
		}
	}

	return null;
}
