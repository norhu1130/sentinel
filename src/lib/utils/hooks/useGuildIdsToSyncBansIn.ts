let cachedGuildIds: string[] = null!;

export function useGuildIdsToSecure() {
	cachedGuildIds ??= process.env.GUILD_IDS_TO_SYNC_BANS_IN!.split(',').map((item) => item.trim());

	return cachedGuildIds;
}
