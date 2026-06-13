import { container } from '@sapphire/framework';
import { LogPrefix } from '../../lib/utils/logPrefix.js';

/**
 * Per-guild set of custom command names that currently exist in *any* clan of that guild.
 *
 * This is only used as a fast-bail in the message trigger hot path: if an incoming message's
 * candidate command name isn't present here, we skip the database entirely. The authoritative,
 * clan-scoped lookup still happens against the database when a name matches.
 */
const cache = new Map<string, Set<string>>();

export async function loadCustomCommands() {
	cache.clear();

	const commands = await container.prisma.customCommand.findMany({
		select: { guildId: true, name: true },
	});

	for (const { guildId, name } of commands) {
		addCustomCommandName(guildId, name);
	}

	container.logger.info(
		`${LogPrefix.CUSTOM_COMMAND} Loaded ${commands.length} custom command(s) across ${cache.size} guild(s) in cache`,
	);
}

export function hasCustomCommandName(guildId: string, name: string): boolean {
	return cache.get(guildId)?.has(name) ?? false;
}

export function addCustomCommandName(guildId: string, name: string): void {
	const names = cache.get(guildId) ?? new Set<string>();
	names.add(name);
	cache.set(guildId, names);
}

/**
 * Removes a command name from the guild cache, but only once no clan in the guild still uses it.
 * The name is shared across clans, so we confirm against the database before evicting.
 */
export async function removeCustomCommandName(guildId: string, name: string): Promise<void> {
	const remaining = await container.prisma.customCommand.count({
		where: { guildId, name },
	});

	if (remaining > 0) {
		return;
	}

	const names = cache.get(guildId);

	if (!names) {
		return;
	}

	names.delete(name);

	if (names.size === 0) {
		cache.delete(guildId);
	}
}
