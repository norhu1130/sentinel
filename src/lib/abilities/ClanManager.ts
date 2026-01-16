import type { Clan, ClanMember, PremiumMember } from '@prisma/client';
import { container, type ILogger } from '@sapphire/framework';
import { Duration } from '@sapphire/time-utilities';
import { ChannelType } from 'discord-api-types/v10';
import type { CategoryChannel, Guild, GuildMember, NonThreadGuildBasedChannel, Role, TextChannel } from 'discord.js';
import { Collection } from 'discord.js';
import { ensureFullMember } from '../utils.js';
import { MemberAbilities } from './MemberAbilities.js';

export const MAX_MEMBERS_IN_CLAN = 40;

export enum ClanCreationAbilityStatus {
	Able = 0,
	MemberNotFound = 1,
	NotAble = 2,
	AbleButNoCustomRole = 3,
}

export enum ClanCreationStatus {
	Created = 0,
	CategoryNotConfigured = 1,
	MemberNotFound = 2,
	NotAble = 3,
	AbleButNoCustomRole = 4,
	CustomRoleNotFound = 5,
	ExistingClanFound = 6,
	CouldNotCreateClanChannel = 7,
}

export enum ClanDeletionStatus {
	Deleted = 0,
	ClanNotFound = 1,
	ClanChannelNotFound = 2,
	CouldNotDeleteClanChannel = 3,
}

export enum ClanMemberAddStatus {
	Added = 0,
	ClanNotFound = 1,
	AlreadyInClan = 2,
	InvitedMemberNotFound = 3,
	CouldNotAddToChannel = 4,
}

export enum ClanMemberRemoveStatus {
	Removed = 0,
	ClanNotFound = 1,
	NotInClan = 2,
}

type CacheType = 'clan' | 'clanChannel' | 'clanMembers' | 'customRole' | 'premiumMember';

export class ClanManager {
	private readonly guildId: string;

	private readonly userOrCustomRoleId?: string;

	private readonly guild: Guild;

	private userId?: string;

	private customRoleId?: string;

	private premiumMember?: PremiumMember | null;

	private clan?: Clan | null;

	private clanChannel?: TextChannel | null;

	private customRole?: Role | null;

	private clanMembers?: Collection<string, ClanMember> | null;

	private discordClanMembers?: Collection<string, GuildMember> | null;

	public constructor(userId: string, guildId: string);
	public constructor(customRoleId: string, guildId: string);
	public constructor(member: GuildMember);
	public constructor(memberOrId: GuildMember | string, guildId?: string) {
		if (typeof memberOrId === 'string' && !guildId) {
			throw new Error('Guild ID is required if memberOrUserId is a user ID');
		}

		if (typeof memberOrId === 'string') {
			this.userOrCustomRoleId = memberOrId;
			this.guildId = guildId!;
		} else {
			this.userId = memberOrId.id;
			this.guildId = memberOrId.guild.id;
		}

		this.guild = container.client.guilds.cache.get(this.guildId)!;
	}

	public static getCreationStatusMessage(status: ClanCreationStatus): string {
		let message = 'Unknown status.';

		switch (status) {
			case ClanCreationStatus.Created:
				message = 'Your clan has been successfully created.';
				break;

			case ClanCreationStatus.CategoryNotConfigured:
				message = 'The clan category has not been set. Please contact modmail to solve this issue.';
				break;

			case ClanCreationStatus.MemberNotFound:
				message = 'There was an error retrieving your profile. Please try again later.';
				break;

			case ClanCreationStatus.NotAble:
				message = 'You do not have the ability to create a clan.';
				break;

			case ClanCreationStatus.AbleButNoCustomRole:
				message = 'You need to create your own custom role before you can create a clan.';
				break;

			case ClanCreationStatus.CustomRoleNotFound:
				message = 'Your custom role could not be found. Please contact modmail to solve this issue.';
				break;

			case ClanCreationStatus.ExistingClanFound:
				message = 'You already own a clan, you cannot create a second one.';
				break;

			case ClanCreationStatus.CouldNotCreateClanChannel:
				message = 'The clan channel could not be created. Please contact modmail to solve this issue.';
				break;
		}

		return message;
	}

	public static getDeletionStatusMessage(status: ClanDeletionStatus): string {
		let message = 'Unknown status.';

		switch (status) {
			case ClanDeletionStatus.Deleted:
				message = 'Your clan has been successfully deleted.';
				break;

			case ClanDeletionStatus.ClanNotFound:
				message = 'You do not own a clan.';
				break;

			case ClanDeletionStatus.ClanChannelNotFound:
				message = 'The clan channel could not be found. Please contact modmail to solve this issue.';
				break;

			case ClanDeletionStatus.CouldNotDeleteClanChannel:
				message = 'The clan channel could not be deleted. Please contact modmail to solve this issue.';
				break;
		}

		return message;
	}

	public static getMemberAddStatusMessage(status: ClanMemberAddStatus): string {
		let message = 'Unknown status.';

		switch (status) {
			case ClanMemberAddStatus.Added:
				message = `✅ You have successfully joined the clan.`;
				break;

			case ClanMemberAddStatus.ClanNotFound:
				message = `❌ This invitation was sent by a member who does not seem to have a clan anymore.`;
				break;

			case ClanMemberAddStatus.AlreadyInClan:
				message = `❌ You are already in the clan.`;
				break;

			case ClanMemberAddStatus.InvitedMemberNotFound:
				message = `❌ Invited member could not be found. Please contact modmail to solve this issue.`;
				break;

			case ClanMemberAddStatus.CouldNotAddToChannel:
				message = `❌ Was not able to add member to the clan channel. Please contact modmail to solve this issue.`;
				break;
		}

		return message;
	}

	public static getMemberRemoveStatusMessage(status: ClanMemberRemoveStatus): string {
		let message = 'Unknown status.';

		switch (status) {
			case ClanMemberRemoveStatus.Removed:
				message = `The member was removed from your clan.`;
				break;

			case ClanMemberRemoveStatus.ClanNotFound:
				message = 'You do not seem to have a clan.';
				break;

			case ClanMemberRemoveStatus.NotInClan:
				message = 'The provided member is not in your clan.';
				break;
		}

		return message;
	}

	public static async fromChannel(channel: TextChannel): Promise<ClanManager | undefined> {
		const clan = await container.prisma.clan.findFirst({
			where: { guildId: channel.guildId, channelId: channel.id },
		});

		if (!clan) {
			return;
		}

		return new ClanManager(clan.customRoleId, channel.guildId);
	}

	public async getClanCategory(): Promise<CategoryChannel | undefined> {
		const guildConfig = await container.prisma.premiumGuildRoleConfig.findFirst({
			where: { guildId: this.guildId },
		});

		if (!guildConfig?.clanCategoryId) {
			return;
		}

		return (
			((await this.guild.channels.fetch(guildConfig.clanCategoryId).catch(() => {})) as CategoryChannel) ??
			undefined
		);
	}

	public getClanOwnerId(): string | undefined {
		return this.userId;
	}

	public async getClanInvitesChannel(): Promise<TextChannel | undefined> {
		const guildConfig = await container.prisma.premiumGuildRoleConfig.findFirst({
			where: { guildId: this.guild.id },
		});

		if (!guildConfig?.clanInviteChannelId) {
			return;
		}

		return (
			((await this.guild.channels.fetch(guildConfig.clanInviteChannelId).catch(() => {})) as TextChannel) ??
			undefined
		);
	}

	public async canCreateClan(): Promise<ClanCreationAbilityStatus> {
		const customRoleId = await this.getCustomRoleId();

		const member = await this.guild.members.fetch(this.getClanOwnerId() ?? '').catch(() => null);

		if (!member) {
			return ClanCreationAbilityStatus.MemberNotFound;
		}

		const memberAbilities = new MemberAbilities(member);
		await memberAbilities.computeAbilities();

		if (!memberAbilities.hasAbility('canCreateClan')) {
			return ClanCreationAbilityStatus.NotAble;
		}

		if (!customRoleId) {
			return ClanCreationAbilityStatus.AbleButNoCustomRole;
		}

		return ClanCreationAbilityStatus.Able;
	}

	public async getClan(): Promise<Clan | null | undefined> {
		if (this.clan === undefined) {
			const customRoleId = await this.getCustomRoleId();

			if (!customRoleId) {
				return;
			}

			this.clan = await container.prisma.clan.findFirst({
				where: { guildId: this.guildId, customRoleId },
			});
		}

		return this.clan;
	}

	public async getClansFromOtherGuilds(): Promise<Clan[]> {
		const customRoleIds = await this.getCustomRoleIdsFromOtherGuilds();

		if (customRoleIds.length < 1) {
			return [];
		}

		return container.prisma.clan.findMany({
			where: { guildId: { not: this.guild.id }, customRoleId: { in: customRoleIds } },
		});
	}

	public async getClanChannel(): Promise<TextChannel | null | undefined> {
		if (this.clanChannel === undefined) {
			const clan = await this.getClan();

			if (!clan) {
				return;
			}

			const channel = await this.guild.channels.fetch(clan.channelId).catch(() => {});

			this.clanChannel = channel as TextChannel | null;
		}

		return this.clanChannel;
	}

	public async getCustomRole(): Promise<Role | null | undefined> {
		if (this.customRole === undefined) {
			const customRoleId = await this.getCustomRoleId();

			if (!customRoleId) {
				return;
			}

			this.customRole = (await this.guild.roles.fetch(customRoleId).catch(() => {})) ?? null;
		}

		return this.customRole;
	}

	public async getClanMembers(): Promise<Collection<string, ClanMember>> {
		if (this.clanMembers === undefined) {
			const collection = new Collection<string, ClanMember>();
			const clan = await this.getClan();

			if (!clan) {
				return collection;
			}

			const clanMembers = await container.prisma.clanMember.findMany({
				where: { clanGuildId: clan.guildId, clanCustomRoleId: clan.customRoleId },
			});

			if (!clanMembers) {
				return collection;
			}

			for await (const clanMember of clanMembers) {
				collection.set(clanMember.userId, clanMember);
			}

			this.clanMembers = collection;
		}

		return this.clanMembers ?? new Collection<string, ClanMember>();
	}

	public async getDiscordClanMembers(): Promise<Collection<string, GuildMember>> {
		if (this.discordClanMembers === undefined) {
			const collection = new Collection<string, GuildMember>();
			const clanMembers = await this.getClanMembers();

			if (clanMembers.size < 1) {
				return collection;
			}

			for await (const clanMember of clanMembers.values()) {
				const member = await this.guild.members.fetch(clanMember.userId).catch(() => {});

				if (member) {
					collection.set(clanMember.userId, member);
				}
			}

			this.discordClanMembers = collection;
		}

		return this.discordClanMembers ?? new Collection<string, GuildMember>();
	}

	public async createClan(description?: string | null): Promise<ClanCreationStatus> {
		const clanCategory = await this.getClanCategory();

		if (!clanCategory) {
			return ClanCreationStatus.CategoryNotConfigured;
		}

		const clanCreationAbility = await this.canCreateClan();

		if (clanCreationAbility === ClanCreationAbilityStatus.MemberNotFound) {
			return ClanCreationStatus.MemberNotFound;
		}

		if (clanCreationAbility === ClanCreationAbilityStatus.NotAble) {
			return ClanCreationStatus.NotAble;
		}

		if (clanCreationAbility === ClanCreationAbilityStatus.AbleButNoCustomRole) {
			return ClanCreationStatus.AbleButNoCustomRole;
		}

		const customRole = await this.getCustomRole();

		if (!customRole) {
			return ClanCreationStatus.CustomRoleNotFound;
		}

		const existingClan = await this.getClan();

		if (existingClan) {
			return ClanCreationStatus.ExistingClanFound;
		}

		void this.log(`Creating clan channel ${customRole.name} for ${this.userId}...`);

		const clanChannel = await this.createClanChannel();

		if (!clanChannel) {
			return ClanCreationStatus.CouldNotCreateClanChannel;
		}

		const clan = await container.prisma.clan.create({
			data: {
				guildId: this.guildId,
				customRoleId: customRole.id,
				channelId: clanChannel.id,
				description,
			},
		});

		await container.prisma.clanMember.create({
			data: {
				clanGuildId: clan!.guildId,
				clanCustomRoleId: clan!.customRoleId,
				userId: this.getClanOwnerId()!,
				claimedRole: true,
			},
		});

		this.clanChannel = clanChannel;
		this.clan = clan;

		return ClanCreationStatus.Created;
	}

	public async deleteClan(): Promise<ClanDeletionStatus> {
		const clan = await this.getClan();

		if (!clan) {
			return ClanDeletionStatus.ClanNotFound;
		}

		const clanChannel = await this.getClanChannel();

		if (clanChannel) {
			try {
				await clanChannel.delete('Member wants to delete their clan');
			} catch {
				return ClanDeletionStatus.CouldNotDeleteClanChannel;
			}
		}

		const discordClanMembers = await this.getDiscordClanMembers();

		for (const member of discordClanMembers.values()) {
			if (!member.roles.cache.has(clan.customRoleId)) {
				continue;
			}

			await member.roles.remove(clan.customRoleId);
		}

		await container.prisma.clanMember.deleteMany({
			where: {
				clanGuildId: clan.guildId,
				clanCustomRoleId: clan.customRoleId,
			},
		});

		await container.prisma.clan.delete({
			where: { guildId_customRoleId: { guildId: clan.guildId, customRoleId: clan.customRoleId } },
		});

		return ClanDeletionStatus.Deleted;
	}

	public async makeClanOrphan(force = false): Promise<void> {
		const clan = await this.getClan();

		if (!clan) {
			void this.logError(`Tried to make clan orphan but no clan found`);
			return;
		}

		if (!force && clan.deletionTaskId) {
			return;
		}

		const deletionDate = new Duration('1 week').fromNow;
		const deletionTask = await container.client.schedule.add(
			'deleteOrphanClan',
			deletionDate,
			JSON.stringify({ userId: this.userId, guildId: this.guildId }),
		);

		await container.prisma.clan.update({
			where: { guildId_customRoleId: { guildId: this.guild.id, customRoleId: clan.customRoleId } },
			data: { deletionTaskId: deletionTask.id },
		});

		void this.log(`Set deletion task ID`, deletionTask.id);
	}

	public async makeClanNotOrphan(): Promise<void> {
		await this.getClan();

		if (!this.getClanOwnerId()) {
			void this.logError(`Tried to make clan *not* orphan but no owner id found`);
			return;
		}

		if (!this.clan?.deletionTaskId) {
			return;
		}

		await container.client.schedule.remove(this.clan.deletionTaskId);
		await container.prisma.clan.update({
			where: { guildId_customRoleId: { guildId: this.guild.id, customRoleId: this.clan.customRoleId } },
			data: { deletionTaskId: null },
		});

		void this.log(`Deleted deletion task to make clan not orphan.`);

		const clanMemberAddStatus = await this.inviteMember(this.getClanOwnerId()!, true);

		if (clanMemberAddStatus !== ClanMemberAddStatus.Added) {
			void this.logError(
				`Could not add owner back: `,
				ClanManager.getMemberAddStatusMessage(clanMemberAddStatus),
			);

			return;
		}

		const channel = await this.getClanChannel();

		if (!channel) {
			void this.logError(`Clan channel does not seem to exist anymore.`);

			return;
		}

		await this.giveOwnerPermissions(channel, this.getClanOwnerId()!).catch((error: Error) => {
			void this.logError(`Restoring clan channel permissions setting for owner failed: `, error);
		});

		void this.log(`Restored clan channel permissions setting for owner.`);
	}

	public async deleteOrphanClan(): Promise<void> {
		const clan = await this.getClan();

		if (!this.getClanOwnerId()) {
			void this.logError(`Could not delete orphan clan: no owner id found`);
			return;
		}

		if (!clan?.deletionTaskId) {
			void this.logError(`Could not delete orphan clan: no ${clan ? 'deletion task id' : 'clan'} found`);
			return;
		}

		const clanDeletionStatus = await this.deleteClan();

		if (clanDeletionStatus !== ClanDeletionStatus.Deleted) {
			void this.logError(
				`Could not delete orphan clan:`,
				ClanManager.getDeletionStatusMessage(clanDeletionStatus),
			);

			return;
		}

		const premiumMember = await this.getPremiumMember();

		if (premiumMember) {
			await ClanManager.deletePremiumRole(premiumMember);
			await ClanManager.deleteGiftedRole(premiumMember);
		}

		await container.prisma.clanMember.deleteMany({
			where: { clanGuildId: this.guildId, userId: this.userId },
		});

		void this.log(`Removed every clan member after clan deletion`);
	}

	public static async deletePremiumRole(premiumMember: PremiumMember): Promise<void> {
		const guild = container.client.guilds.cache.get(premiumMember.guildId);

		if (!guild || !premiumMember?.customRoleId) {
			return;
		}

		try {
			await guild.roles.delete(
				premiumMember.customRoleId,
				'Member who created custom role either left the server or lost premium role',
			);

			container.logger.info(
				`[PREMIUM @${premiumMember.userId}@&${premiumMember.customRoleId}] Deleted custom premium role (Discord)`,
			);
		} catch (error) {
			container.logger.error(
				`[PREMIUM @${premiumMember.userId}@&${premiumMember.customRoleId}] Failed to delete custom premium role`,
				{
					userId: premiumMember.userId,
					guildId: premiumMember.guildId,
					error,
				},
			);
		}

		await container.prisma.premiumMember.update({
			where: { guildId_userId: { guildId: premiumMember.guildId, userId: premiumMember.userId } },
			data: { customRoleId: null },
		});

		container.logger.info(
			`[PREMIUM @${premiumMember.userId}@&${premiumMember.customRoleId}] Deleted custom premium role (database)`,
		);
	}

	public static async deleteGiftedRole(premiumMember: PremiumMember): Promise<void> {
		const guild = container.client.guilds.cache.get(premiumMember.guildId);
		const guildConfig = await container.prisma.premiumGuildRoleConfig.findFirst({
			where: { guildId: premiumMember.guildId },
		});

		if (!guild || !premiumMember?.giftedRoleToUserId || !guildConfig?.legendRoleId) {
			return;
		}

		const giftedUser = await guild.members.fetch(premiumMember.giftedRoleToUserId).catch(() => null);

		if (giftedUser) {
			try {
				await giftedUser.roles.remove(guildConfig.legendRoleId, 'Original premium member left server');
				container.logger.info(
					`[PREMIUM @${premiumMember.userId}@&${premiumMember.customRoleId}] Deleted gifted role (Discord)`,
				);
			} catch (error) {
				container.logger.error(
					`[PREMIUM @${premiumMember.userId}@&${premiumMember.customRoleId}] Failed to remove gifted role`,
					{
						userId: giftedUser.id,
						guildId: premiumMember.guildId,
						giftedBy: premiumMember.userId,
						error,
					},
				);
			}
		}

		await container.prisma.premiumMember.update({
			where: { guildId_userId: { guildId: premiumMember.guildId, userId: premiumMember.userId } },
			data: { giftedRoleToUserId: null },
		});

		container.logger.info(
			`[PREMIUM @${premiumMember.userId}@&${premiumMember.customRoleId}] Deleted gifted role (database)`,
		);
	}

	public async inviteMember(memberId: string, force = false): Promise<ClanMemberAddStatus> {
		const clan = await this.getClan();

		if (!clan) {
			return ClanMemberAddStatus.ClanNotFound;
		}

		const clanMembers = await this.getDiscordClanMembers();

		if (clanMembers.has(memberId) && !force) {
			return ClanMemberAddStatus.AlreadyInClan;
		}

		const invitedMember = await this.guild.members.fetch(memberId).catch(() => {});

		if (!invitedMember) {
			return ClanMemberAddStatus.InvitedMemberNotFound;
		}

		const customRoleId = await this.getCustomRoleId();
		const clanChannel = await this.getClanChannel();
		const addedToChannel = await clanChannel?.permissionOverwrites
			.create(invitedMember, {
				ViewChannel: true,
			})
			.then(() => true)
			.catch(() => false);

		if (!addedToChannel) {
			return ClanMemberAddStatus.CouldNotAddToChannel;
		}

		if (!clanMembers.has(memberId)) {
			await container.prisma.clanMember.create({
				data: {
					clanGuildId: clan.guildId,
					clanCustomRoleId: clan.customRoleId,
					userId: invitedMember.id,
					claimedRole: true,
				},
			});
		}

		await invitedMember.roles.add(customRoleId!);

		this.invalidateCache('clanMembers');

		return ClanMemberAddStatus.Added;
	}

	public async removeMember(member: GuildMember): Promise<ClanMemberRemoveStatus> {
		await this.log(`Trying to remove member ${member.user.username} (${member.id})`);

		const clan = await this.getClan();

		if (!clan) {
			await this.log(`Could not remove member ${member.user.username} (${member.id}): no clan found`);
			return ClanMemberRemoveStatus.ClanNotFound;
		}

		const customRoleId = await this.getCustomRoleId();
		const clanMembers = await this.getDiscordClanMembers();
		const clanChannel = await this.getClanChannel();

		await ensureFullMember(member);

		if (customRoleId && member.roles.cache.has(customRoleId)) {
			await this.log(`Removing member ${member.user.username} (${member.id}): removing custom role first`);
			await member.roles.remove(customRoleId);
			await this.log(`Removing member ${member.user.username} (${member.id}): removed custom role`);
		}

		await this.log(`Removing member ${member.user.username} (${member.id}): removing permission overwrites`);
		await clanChannel?.permissionOverwrites.delete(member.id);
		await this.log(`Removing member ${member.user.username} (${member.id}): removed permission overwrites`);

		await this.log(`Removing member ${member.user.username} (${member.id}): deleting clan member entry`);
		await container.prisma.clanMember.delete({
			where: {
				clanGuildId_clanCustomRoleId_userId: {
					clanGuildId: clan!.guildId,
					clanCustomRoleId: clan!.customRoleId,
					userId: member.id,
				},
			},
		});
		await this.log(`Removing member ${member.user.username} (${member.id}): deleted clan member entry`);

		this.invalidateCache('clanMembers');

		return clanMembers.has(member.id) ? ClanMemberRemoveStatus.Removed : ClanMemberRemoveStatus.NotInClan;
	}

	public async getCustomRoleId(): Promise<string | undefined> {
		if (!this.customRoleId) {
			const premiumMember = await this.getPremiumMember();

			this.customRoleId = premiumMember?.customRoleId ?? this.userOrCustomRoleId;
		}

		return this.customRoleId;
	}

	public invalidateCache(type: CacheType): void {
		this[type] = undefined;

		if (type === 'clanMembers') {
			this.discordClanMembers = undefined;
		}
	}

	private async createClanChannel(): Promise<TextChannel | undefined> {
		const customRole = await this.getCustomRole();

		if (!customRole || !this.getClanOwnerId()) {
			return;
		}

		const clanCategory = await this.getClanCategory();

		if (!clanCategory) {
			return;
		}

		const clanChannel = await this.guild.channels
			.create({
				name: customRole.name,
				type: ChannelType.GuildText,
				parent: clanCategory.id,
				topic: 'Clan channel for ' + customRole.name,
				reason: 'Creating clan channel for ' + this.userId,
			})
			.catch((error) => void this.logError(`Clan channel creation failed: `, error));

		if (!clanChannel) {
			return;
		}

		let errorHappened = false;

		await clanChannel.lockPermissions().catch((error) => {
			errorHappened = true;
			void this.logError(`Clan channel permissions locking failed: `, error);
		});
		await clanChannel.permissionOverwrites
			.edit(this.guild.roles.everyone.id, {
				ViewChannel: false,
				CreatePublicThreads: true,
				SendPolls: true,
				SendVoiceMessages: true,
				UseEmbeddedActivities: true,
				EmbedLinks: true,
				AttachFiles: true,
				AddReactions: true,
				UseExternalEmojis: true,
				UseExternalStickers: true,
				UseExternalApps: true,
			})
			.catch((error) => {
				errorHappened = true;
				void this.logError(`Clan channel permissions setting for @everyone failed: `, error);
			});

		await this.giveOwnerPermissions(clanChannel, this.getClanOwnerId()!).catch((error: Error) => {
			errorHappened = true;
			void this.logError(`Clan channel permissions setting for owner failed: `, error);
		});

		if (errorHappened) {
			await clanChannel.delete();
			return;
		}

		return clanChannel;
	}

	private async giveOwnerPermissions(channel: TextChannel, ownerId: string): Promise<NonThreadGuildBasedChannel> {
		return channel.permissionOverwrites.edit(ownerId, {
			ViewChannel: true,
			ManageChannels: true,
			ManageMessages: true,
			CreatePrivateThreads: true,
			MentionEveryone: true,
		});
	}

	private async getPremiumMember(): Promise<PremiumMember | null> {
		if (this.premiumMember === undefined) {
			this.premiumMember = await container.prisma.premiumMember.findFirst({
				where: { guildId: this.guildId, userId: this.getClanOwnerId() ?? this.userOrCustomRoleId },
			});
		}

		if (!this.userId && this.premiumMember?.userId === this.userOrCustomRoleId) {
			this.userId = this.userOrCustomRoleId;
		}

		if (!this.customRoleId && this.premiumMember?.customRoleId === this.userOrCustomRoleId) {
			this.customRoleId = this.userOrCustomRoleId;
		}

		return this.premiumMember;
	}

	private async getPremiumMembersFromOtherGuilds(): Promise<PremiumMember[] | null> {
		return container.prisma.premiumMember.findMany({
			where: { guildId: { not: this.guildId }, userId: this.userId },
		});
	}

	private async getCustomRoleIdsFromOtherGuilds(): Promise<string[]> {
		const premiumMembers = await this.getPremiumMembersFromOtherGuilds();

		return (premiumMembers?.map((premiumMember) => premiumMember?.customRoleId).filter(Boolean) ?? []) as string[];
	}

	private async getLogPrefix(): Promise<string> {
		const ids = [
			{ prefix: '@', id: this.getClanOwnerId() },
			{ prefix: '@&', id: await this.getCustomRoleId() },
			{ prefix: '#', id: (await this.getClanChannel())?.id },
			{ prefix: '*', id: this.guildId },
		]
			.map((element) => `${element.id ? `${element.prefix}${element.id}` : ''}`)
			.join('');

		return `[CLAN ${ids}] `;
	}

	private async doLog(
		log: readonly unknown[],
		level: Exclude<keyof ILogger, 'has' | 'write'> = 'info',
	): Promise<void> {
		container.logger[level](await this.getLogPrefix(), ...log);
	}

	private async log(...log: readonly unknown[]): Promise<void> {
		return this.doLog(log);
	}

	private async logError(...log: readonly unknown[]): Promise<void> {
		return this.doLog(log, 'error');
	}
}
