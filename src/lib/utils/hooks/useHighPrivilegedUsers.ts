let cachedUserIds: string[] = null!;

export function useHighPrivilegedUsers() {
	cachedUserIds ??= process.env.USER_IDS_WHO_CAN_RUN_HIGH_PRIVILEGE_COMMANDS!.split(',').map((item) => item.trim());

	return cachedUserIds;
}
