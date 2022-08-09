export function trimPretty(item: string, maxLength: number) {
	if (item.length > maxLength) {
		return `${item.substring(0, maxLength - 1)}...`;
	}

	return item;
}
