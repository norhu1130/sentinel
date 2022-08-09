import { ApplyOptions } from '@sapphire/decorators';
import { Events, Listener } from '@sapphire/framework';
import type { Role } from 'discord.js';

@ApplyOptions<Listener.Options>({ event: Events.GuildRoleDelete })
export class DeleteSyncEntryOnRoleDelete extends Listener {
	public async run(role: Role) {
		await this.container.prisma.roleSync.deleteMany({
			where: { OR: [{ origin_role_id: role.id }, { destination_role_id: role.id }] },
		});
	}
}
