import { ApplyOptions } from '@sapphire/decorators';
import { Events, Listener } from '@sapphire/framework';
import type { GuildMember } from 'discord.js';
import { ClanManager } from '../../../lib/abilities/ClanManager.js';
import { MemberAbilities } from '../../../lib/abilities/MemberAbilities.js';
import { LogPrefix } from '../../../lib/utils/logPrefix.js';
import { ensureFullMember } from '../../../lib/utils.js';

@ApplyOptions<Listener.Options>({ event: Events.GuildMemberUpdate })
export class PremiumSubscribe extends Listener<typeof Events.GuildMemberUpdate> {
	public override async run(oldMember: GuildMember, newMember: GuildMember) {
		await ensureFullMember(oldMember);
		await ensureFullMember(newMember);

		const oldMemberAbilities = new MemberAbilities(oldMember);
		const newMemberAbilities = new MemberAbilities(newMember);

		await oldMemberAbilities.computeAbilities();
		await newMemberAbilities.computeAbilities();

		if (newMemberAbilities.hasNone() || oldMemberAbilities.hasEqualAbilities(newMemberAbilities)) {
			return;
		}

		this.container.logger.info(`${LogPrefix.PREMIUM} ${newMember.user.tag} has gained some premium abilities`, {
			userId: newMember.id,
			guildId: newMember.guild.id,
		});

		const clanManager = new ClanManager(newMember);
		const clan = await clanManager.getClan();
		const canNowCreateClan =
			!oldMemberAbilities.hasAbility('canCreateClan') && newMemberAbilities.hasAbility('canCreateClan');

		// If user has a clan, we can end the cooldown and un-orphan the clan
		if (canNowCreateClan && clan) {
			await clanManager.makeClanNotOrphan({ actorUserId: newMember.id, reason: 'Owner regained premium' });
		}
	}
}
