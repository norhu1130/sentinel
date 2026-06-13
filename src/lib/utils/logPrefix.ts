import {
	blue,
	blueBright,
	cyan,
	cyanBright,
	green,
	greenBright,
	magenta,
	magentaBright,
	yellow,
	yellowBright,
} from 'colorette';

type ColorFunction = (text: string) => string;
type ColorName =
	| 'blue'
	| 'blueBright'
	| 'cyan'
	| 'cyanBright'
	| 'green'
	| 'greenBright'
	| 'magenta'
	| 'magentaBright'
	| 'yellow'
	| 'yellowBright';

const COLORS: ColorFunction[] = [
	cyan,
	cyanBright,
	green,
	greenBright,
	yellow,
	yellowBright,
	blue,
	blueBright,
	magenta,
	magentaBright,
];

const COLOR_MAP: Record<ColorName, ColorFunction> = {
	blue,
	blueBright,
	cyan,
	cyanBright,
	green,
	greenBright,
	magenta,
	magentaBright,
	yellow,
	yellowBright,
};

/**
 * Simple hash function to generate a deterministic number from a string.
 */
function hashString(str: string): number {
	let hash = 0;
	for (let idx = 0; idx < str.length; idx++) {
		const char = str.codePointAt(idx) ?? 0;
		hash = (hash << 5) - hash + char;
		hash = Math.trunc(hash);
	}

	return Math.abs(hash);
}

/**
 * Creates a colorized log prefix. Color is deterministically generated based on the prefix string.
 */
function colorize(prefix: string, forcedColor?: ColorName): string {
	if (forcedColor && COLOR_MAP[forcedColor]) {
		return COLOR_MAP[forcedColor](prefix);
	}

	const hash = hashString(prefix);
	const colorIndex = hash % COLORS.length;
	return COLORS[colorIndex](prefix);
}

/**
 * Centralized log prefixes for consistent logging across the codebase.
 *
 * Colors are auto-generated based on the prefix string, ensuring the same
 * prefix always gets the same color.
 *
 * @example
 * ```ts
 * import { LogPrefix } from '../lib/utils/logPrefix.js';
 *
 * this.container.logger.info(`${LogPrefix.BAN_SYNC} Starting...`);
 * ```
 */
export const LogPrefix = {
	// Startup & Core
	MEMBER_CACHE: colorize('[MEMBER CACHE]'),
	MEDIA_ONLY: colorize('[MEDIA ONLY]'),

	// Premium & Clan System
	PREMIUM: colorize('[PREMIUM]'),
	PREMIUM_ABILITY_CHECK: colorize('[PREMIUM ABILITY CHECK]'),
	CUSTOM_ROLE: colorize('[CUSTOM ROLE]'),
	CUSTOM_COMMAND: colorize('[CUSTOM COMMAND]'),
	CLAN: colorize('[CLAN]'),
	CLAN_DIRECTORY: colorize('[CLAN DIRECTORY]'),
	CLAN_JOIN_REQUEST: colorize('[CLAN JOIN REQUEST]'),
	ICON_SYNC: colorize('[ICON SYNC]'),

	// Moderation & Sync
	BAN_SYNC: colorize('[BAN SYNC]'),
	ROLE_SYNC: colorize('[ROLE SYNC]'),
	VISIBLE_RANK_ROLE: colorize('[VISIBLE RANK ROLE]'),

	// Scheduled Tasks
	AUTOPIN: colorize('[AUTOPIN]'),
	INVITE_PRUNE: colorize('[INVITE PRUNE]'),

	// Vote Kick System
	KICK_COUNTER_RESET: colorize('[KICK COUNTER RESET]'),
	ROLE_REMOVAL: colorize('[ROLE REMOVAL]'),
} as const;
