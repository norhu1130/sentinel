import type { Clan, ClanMember, PremiumMember } from '@prisma/client';
import { container, type ILogger } from '@sapphire/framework';
import { Duration } from '@sapphire/time-utilities';
import * as Sentry from '@sentry/node';
import { ChannelType, OverwriteType, RESTJSONErrorCodes } from 'discord-api-types/v10';
import type { CategoryChannel, Guild, GuildMember, NonThreadGuildBasedChannel, Role, TextChannel } from 'discord.js';
import { Collection, DiscordAPIError } from 'discord.js';
import { recordClanEvent } from '../utils/clanHistory.js';
import { LogPrefix } from '../utils/logPrefix.js';
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

export enum ClanPermissionEditTarget {
	Everyone = 'everyone',
	Owner = 'owner',
}

export enum ClanPermissionEditStatus {
	Success = 0,
	NoChannel = 1,
	NoOwner = 2,
	OwnerNotInGuild = 3,
	Error = 4,
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
			this.addBreadcrumb('getClan: retrieving custom role ID...');
			const customRoleId = await this.getCustomRoleId();

			if (!customRoleId) {
				this.addBreadcrumb('getClan: no custom role ID found', undefined, 'warning');
				return;
			}

			try {
				this.addBreadcrumb('getClan: custom role id retrieved, fetching clan from database', {
					found: Boolean(this.clan),
					customRoleId,
				});
				this.clan = await container.prisma.clan.findFirst({
					where: { guildId: this.guildId, customRoleId },
				});
				this.addBreadcrumb('getClan: database query completed', {
					found: Boolean(this.clan),
					customRoleId,
				});
			} catch (error) {
				this.addBreadcrumb('getClan: database query failed', { error: String(error), customRoleId }, 'error');
				this.captureError(error as Error, 'getClan: database query failed');
				return null;
			}
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
			this.addBreadcrumb('Fetching clan channel');
			const clan = await this.getClan();

			if (!clan) {
				this.addBreadcrumb('getClanChannel: no clan found', undefined, 'warning');
				return;
			}

			this.addBreadcrumb('getClanChannel: fetching Discord channel', { channelId: clan.channelId });
			const channel = await this.guild.channels.fetch(clan.channelId).catch(async (error) => {
				this.addBreadcrumb(
					'getClanChannel: failed to fetch Discord channel',
					{ channelId: clan.channelId, error: String(error) },
					'error',
				);
				this.captureWarning(`Failed to fetch clan channel ${clan.channelId}`, { error: String(error) });
				return null;
			});

			this.clanChannel = channel as TextChannel | null;
			this.addBreadcrumb('getClanChannel: completed', {
				found: Boolean(this.clanChannel),
				channelId: clan.channelId,
			});
		}

		return this.clanChannel;
	}

	public async getCustomRole(): Promise<Role | null | undefined> {
		if (this.customRole === undefined) {
			this.addBreadcrumb('Fetching custom role');
			const customRoleId = await this.getCustomRoleId();

			if (!customRoleId) {
				this.addBreadcrumb('getCustomRole: no custom role ID found', undefined, 'warning');
				return;
			}

			this.addBreadcrumb('getCustomRole: fetching Discord role', { roleId: customRoleId });
			this.customRole =
				(await this.guild.roles.fetch(customRoleId).catch(async (error) => {
					this.addBreadcrumb(
						'getCustomRole: failed to fetch Discord role',
						{ roleId: customRoleId, error: String(error) },
						'error',
					);
					this.captureWarning(`Failed to fetch custom role ${customRoleId}`, { error: String(error) });
					return null;
				})) ?? null;

			this.addBreadcrumb('getCustomRole: completed', {
				found: Boolean(this.customRole),
				roleId: customRoleId,
			});
		}

		return this.customRole;
	}

	public async getClanMembers(): Promise<Collection<string, ClanMember>> {
		if (this.clanMembers === undefined) {
			this.addBreadcrumb('Fetching clan members from database');
			const collection = new Collection<string, ClanMember>();
			const clan = await this.getClan();

			if (!clan) {
				this.addBreadcrumb('getClanMembers: no clan found', undefined, 'warning');
				return collection;
			}

			try {
				const clanMembers = await container.prisma.clanMember.findMany({
					where: { clanGuildId: clan.guildId, clanCustomRoleId: clan.customRoleId },
				});

				if (!clanMembers) {
					this.addBreadcrumb('getClanMembers: no members found in database', undefined, 'info');
					return collection;
				}

				for await (const clanMember of clanMembers) {
					collection.set(clanMember.userId, clanMember);
				}

				this.clanMembers = collection;
				this.addBreadcrumb('getClanMembers: completed', { memberCount: collection.size });
			} catch (error) {
				this.addBreadcrumb('getClanMembers: database query failed', { error: String(error) }, 'error');
				this.captureError(error as Error, 'getClanMembers: database query failed');
				return collection;
			}
		}

		return this.clanMembers ?? new Collection<string, ClanMember>();
	}

	public async getDiscordClanMembers(): Promise<Collection<string, GuildMember>> {
		if (this.discordClanMembers === undefined) {
			this.addBreadcrumb('Fetching Discord clan members');
			const collection = new Collection<string, GuildMember>();
			const clanMembers = await this.getClanMembers();

			if (clanMembers.size < 1) {
				this.addBreadcrumb('getDiscordClanMembers: no clan members in database', undefined, 'info');
				return collection;
			}

			for await (const clanMember of clanMembers.values()) {
				const member = await this.guild.members.fetch(clanMember.userId).catch(() => undefined);

				if (member) {
					collection.set(clanMember.userId, member);
				}
			}

			this.discordClanMembers = collection;
			const fetchFailures = clanMembers.size - collection.size;
			this.addBreadcrumb('getDiscordClanMembers: completed', {
				totalInDb: clanMembers.size,
				fetchedFromDiscord: collection.size,
				fetchFailures,
			});

			if (fetchFailures > 0) {
				this.addBreadcrumb(
					'getDiscordClanMembers: some members could not be fetched from Discord',
					{ fetchFailures },
					'warning',
				);
			}
		}

		return this.discordClanMembers ?? new Collection<string, GuildMember>();
	}

	public async createClan(description?: string | null): Promise<ClanCreationStatus> {
		this.addBreadcrumb('Starting createClan');

		const clanCategory = await this.getClanCategory();

		if (!clanCategory) {
			this.addBreadcrumb('createClan failed: category not configured', undefined, 'warning');
			return ClanCreationStatus.CategoryNotConfigured;
		}

		const clanCreationAbility = await this.canCreateClan();

		if (clanCreationAbility === ClanCreationAbilityStatus.MemberNotFound) {
			this.addBreadcrumb('createClan failed: member not found', undefined, 'warning');
			return ClanCreationStatus.MemberNotFound;
		}

		if (clanCreationAbility === ClanCreationAbilityStatus.NotAble) {
			this.addBreadcrumb('createClan failed: not able to create clan', undefined, 'warning');
			return ClanCreationStatus.NotAble;
		}

		if (clanCreationAbility === ClanCreationAbilityStatus.AbleButNoCustomRole) {
			this.addBreadcrumb('createClan failed: able but no custom role', undefined, 'warning');
			return ClanCreationStatus.AbleButNoCustomRole;
		}

		const customRole = await this.getCustomRole();

		if (!customRole) {
			this.addBreadcrumb('createClan failed: custom role not found', undefined, 'error');
			return ClanCreationStatus.CustomRoleNotFound;
		}

		const existingClan = await this.getClan();

		if (existingClan) {
			this.addBreadcrumb('createClan failed: existing clan found', undefined, 'warning');
			return ClanCreationStatus.ExistingClanFound;
		}

		this.log(`Creating clan channel ${customRole.name} for ${this.userId}...`);
		this.addBreadcrumb('Creating clan channel', { roleName: customRole.name });

		const clanChannel = await this.createClanChannel();

		if (!clanChannel) {
			this.addBreadcrumb('createClan failed: could not create channel', undefined, 'error');
			return ClanCreationStatus.CouldNotCreateClanChannel;
		}

		try {
			this.addBreadcrumb('Creating clan database entry', { channelId: clanChannel.id });
			const clan = await container.prisma.clan.create({
				data: {
					guildId: this.guildId,
					customRoleId: customRole.id,
					channelId: clanChannel.id,
					description,
				},
			});

			this.addBreadcrumb('Creating clan member entry for owner');
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

			await recordClanEvent({
				guildId: this.guildId,
				customRoleId: customRole.id,
				clanName: customRole.name,
				ownerUserId: this.getClanOwnerId() ?? null,
				actorUserId: this.getClanOwnerId() ?? null,
				eventType: 'Created',
				metadata: { channelId: clanChannel.id, description: description ?? null },
			});

			this.addBreadcrumb('createClan completed successfully', { clanChannelId: clanChannel.id });
			return ClanCreationStatus.Created;
		} catch (error) {
			this.addBreadcrumb('createClan database operations failed', { error: String(error) }, 'error');
			this.captureError(error as Error, 'createClan: database operations failed');
			try {
				await clanChannel.delete('Cleanup after failed clan creation');
			} catch (cleanupError) {
				this.addBreadcrumb(
					'Failed to cleanup channel after creation failure',
					{ error: String(cleanupError) },
					'error',
				);
			}

			return ClanCreationStatus.CouldNotCreateClanChannel;
		}
	}

	public async deleteClan(context?: { actorUserId?: string; reason?: string }): Promise<ClanDeletionStatus> {
		this.addBreadcrumb('Starting clan deletion');

		const clan = await this.getClan();

		if (!clan) {
			this.addBreadcrumb('Clan deletion failed: clan not found', undefined, 'warning');
			return ClanDeletionStatus.ClanNotFound;
		}

		const clanChannel = await this.getClanChannel();

		if (clanChannel) {
			try {
				this.addBreadcrumb('Deleting clan channel', { channelId: clanChannel.id });
				await clanChannel.delete('Member wants to delete their clan');
				this.addBreadcrumb('Clan channel deleted successfully');
			} catch (error) {
				this.addBreadcrumb('Failed to delete clan channel', { error: String(error) }, 'error');
				this.captureError(error as Error, 'deleteClan: channel deletion failed');
				return ClanDeletionStatus.CouldNotDeleteClanChannel;
			}
		} else {
			this.addBreadcrumb('No clan channel to delete', undefined, 'warning');
		}

		const discordClanMembers = await this.getDiscordClanMembers();
		this.addBreadcrumb('Removing clan role from members', { memberCount: discordClanMembers.size });

		let roleRemovalFailures = 0;
		for (const member of discordClanMembers.values()) {
			if (!member.roles.cache.has(clan.customRoleId)) {
				continue;
			}

			try {
				await member.roles.remove(clan.customRoleId);
				this.addBreadcrumb('Removed clan role from member', { memberId: member.id });
			} catch (error) {
				roleRemovalFailures++;
				this.addBreadcrumb(
					'Failed to remove clan role from member',
					{ memberId: member.id, error: String(error) },
					'error',
				);
				this.captureWarning(`Failed to remove clan role from member ${member.id} during clan deletion`, {
					memberId: member.id,
					error: String(error),
				});
			}
		}

		if (roleRemovalFailures > 0) {
			this.addBreadcrumb(
				'Some role removals failed during deletion',
				{ failureCount: roleRemovalFailures },
				'warning',
			);
		}

		try {
			this.addBreadcrumb('Deleting clan members from database');
			await container.prisma.clanMember.deleteMany({
				where: {
					clanGuildId: clan.guildId,
					clanCustomRoleId: clan.customRoleId,
				},
			});
			this.addBreadcrumb('Clan members deleted from database');
		} catch (error) {
			this.addBreadcrumb('Failed to delete clan members from database', { error: String(error) }, 'error');
			this.captureError(error as Error, 'deleteClan: clanMember deleteMany failed');
		}

		try {
			this.addBreadcrumb('Deleting clan from database');
			await container.prisma.clan.delete({
				where: { guildId_customRoleId: { guildId: clan.guildId, customRoleId: clan.customRoleId } },
			});
			this.addBreadcrumb('Clan deleted from database');
		} catch (error) {
			this.addBreadcrumb('Failed to delete clan from database', { error: String(error) }, 'error');
			this.captureError(error as Error, 'deleteClan: clan delete failed');
		}

		this.addBreadcrumb('Clan deletion completed');
		await recordClanEvent({
			guildId: clan.guildId,
			customRoleId: clan.customRoleId,
			clanName: this.clanChannel?.name ?? this.customRole?.name ?? null,
			ownerUserId: this.getClanOwnerId() ?? null,
			actorUserId: context?.actorUserId ?? null,
			eventType: 'Deleted',
			reason: context?.reason ?? null,
		});
		return ClanDeletionStatus.Deleted;
	}

	public async makeClanOrphan(force = false, reason?: string): Promise<void> {
		this.addBreadcrumb('Starting makeClanOrphan', { force });

		const clan = await this.getClan();

		if (!clan) {
			this.logError(`Tried to make clan orphan but no clan found`);
			this.addBreadcrumb('makeClanOrphan failed: no clan found', undefined, 'error');
			this.captureWarning('Tried to make clan orphan but no clan found');
			return;
		}

		if (!force && clan.deletionTaskId) {
			this.addBreadcrumb('Clan already orphaned, skipping', { existingTaskId: clan.deletionTaskId });
			return;
		}

		const deletionDate = new Duration('1 week').fromNow;

		try {
			this.addBreadcrumb('Scheduling orphan deletion task', { deletionDate: deletionDate.toISOString() });
			const deletionTask = await container.client.schedule.add(
				'deleteOrphanClan',
				deletionDate,
				JSON.stringify({ customRoleId: clan.customRoleId, guildId: this.guildId }),
			);

			this.addBreadcrumb('Updating clan with deletion task ID', { taskId: deletionTask.id });
			await container.prisma.clan.update({
				where: { guildId_customRoleId: { guildId: this.guild.id, customRoleId: clan.customRoleId } },
				data: { deletionTaskId: deletionTask.id },
			});

			this.log(`Set deletion task ID`, deletionTask.id);
			this.addBreadcrumb('Clan marked as orphan successfully', { taskId: deletionTask.id });
			await recordClanEvent({
				guildId: this.guildId,
				customRoleId: clan.customRoleId,
				clanName: this.customRole?.name ?? this.clanChannel?.name ?? null,
				ownerUserId: this.getClanOwnerId() ?? null,
				eventType: 'Orphaned',
				reason: reason ?? null,
				metadata: { deletionTaskId: deletionTask.id, deletionDate: deletionDate.toISOString() },
			});
		} catch (error) {
			this.addBreadcrumb('Failed to make clan orphan', { error: String(error) }, 'error');
			this.logError('Failed to make clan orphan:', error);
			this.captureError(error as Error, 'makeClanOrphan: scheduling or database update failed');
		}
	}

	public async makeClanNotOrphan(context?: { actorUserId?: string; reason?: string }): Promise<void> {
		this.addBreadcrumb('Starting makeClanNotOrphan');
		await this.getClan();

		if (!this.getClanOwnerId()) {
			this.logError(`Tried to make clan *not* orphan but no owner id found`);
			this.addBreadcrumb('makeClanNotOrphan failed: no owner id', undefined, 'error');
			this.captureWarning('Tried to make clan not orphan but no owner id found');
			return;
		}

		if (!this.clan?.deletionTaskId) {
			this.addBreadcrumb('Clan not orphaned (no deletion task), skipping');
			return;
		}

		try {
			this.addBreadcrumb('Removing scheduled deletion task', { taskId: this.clan.deletionTaskId });
			await container.client.schedule.remove(this.clan.deletionTaskId);
			this.addBreadcrumb('Clearing deletion task ID in database');
			await container.prisma.clan.update({
				where: { guildId_customRoleId: { guildId: this.guild.id, customRoleId: this.clan.customRoleId } },
				data: { deletionTaskId: null },
			});
			this.addBreadcrumb('Deletion task removed successfully');
		} catch (error) {
			this.addBreadcrumb('Failed to remove deletion task', { error: String(error) }, 'error');
			this.logError('Failed to remove deletion task:', error);
			this.captureError(error as Error, 'makeClanNotOrphan: failed to remove deletion task');
		}

		this.log(`Deleted deletion task to make clan not orphan.`);

		this.addBreadcrumb('Re-adding owner to clan', { ownerId: this.getClanOwnerId() });
		const clanMemberAddStatus = await this.inviteMember(this.getClanOwnerId()!, true, { recordHistory: false });

		if (clanMemberAddStatus !== ClanMemberAddStatus.Added) {
			const statusMessage = ClanManager.getMemberAddStatusMessage(clanMemberAddStatus);
			this.logError(`Could not add owner back: `, statusMessage);
			this.addBreadcrumb(
				'Failed to re-add owner to clan',
				{ status: clanMemberAddStatus, statusMessage },
				'error',
			);
			this.captureWarning(`Could not add owner back during makeClanNotOrphan: ${statusMessage}`, {
				status: clanMemberAddStatus,
			});
			return;
		}

		this.addBreadcrumb('Owner re-added to clan successfully');

		const channel = await this.getClanChannel();

		if (!channel) {
			this.logError(`Clan channel does not seem to exist anymore.`);
			this.addBreadcrumb('Clan channel not found during recovery', undefined, 'error');
			this.captureWarning('Clan channel not found during makeClanNotOrphan');
			return;
		}

		await this.giveOwnerPermissions(channel, this.getClanOwnerId()!).catch(async (error: Error) => {
			this.logError(`Restoring clan channel permissions setting for owner failed: `, error);
			this.addBreadcrumb('Failed to restore owner permissions', { error: String(error) }, 'error');
			this.captureError(error, 'makeClanNotOrphan: failed to restore owner permissions');
		});

		this.log(`Restored clan channel permissions setting for owner.`);
		this.addBreadcrumb('makeClanNotOrphan completed successfully');

		if (this.clan) {
			await recordClanEvent({
				guildId: this.guildId,
				customRoleId: this.clan.customRoleId,
				clanName: this.customRole?.name ?? this.clanChannel?.name ?? null,
				ownerUserId: this.getClanOwnerId() ?? null,
				actorUserId: context?.actorUserId ?? null,
				eventType: 'OrphanCancelled',
				reason: context?.reason ?? null,
			});
		}
	}

	public async deleteOrphanClan(): Promise<void> {
		this.addBreadcrumb('Starting deleteOrphanClan (scheduled task)');

		const clan = await this.getClan();

		if (!clan?.deletionTaskId) {
			const reason = clan ? 'deletion task id' : 'clan';
			this.logError(`Could not delete orphan clan: no ${reason} found`);
			this.addBreadcrumb(
				'deleteOrphanClan failed: missing data',
				{ hasClan: Boolean(clan), hasTaskId: Boolean(clan?.deletionTaskId) },
				'error',
			);
			this.captureWarning(`Could not delete orphan clan: no ${reason} found`);
			return;
		}

		this.addBreadcrumb('Deleting orphan clan', { deletionTaskId: clan.deletionTaskId });
		const clanDeletionStatus = await this.deleteClan({ reason: 'Orphan grace period expired' });

		if (clanDeletionStatus !== ClanDeletionStatus.Deleted) {
			const statusMessage = ClanManager.getDeletionStatusMessage(clanDeletionStatus);
			this.logError(`Could not delete orphan clan:`, statusMessage);
			this.addBreadcrumb('Orphan clan deletion failed', { status: clanDeletionStatus, statusMessage }, 'error');
			this.captureError(new Error(`Orphan clan deletion failed: ${statusMessage}`), 'deleteOrphanClan', {
				status: clanDeletionStatus,
			});
			return;
		}

		this.addBreadcrumb('Orphan clan deleted, cleaning up premium member data');

		const premiumMember = await this.getPremiumMember();

		if (premiumMember) {
			this.addBreadcrumb('Deleting premium role', { premiumUserId: premiumMember.userId });
			try {
				await ClanManager.deletePremiumRole(premiumMember);
				this.addBreadcrumb('Premium role deleted');
			} catch (error) {
				this.addBreadcrumb('Failed to delete premium role', { error: String(error) }, 'error');
				this.captureError(error as Error, 'deleteOrphanClan: deletePremiumRole failed');
			}

			this.addBreadcrumb('Deleting gifted role');
			try {
				await ClanManager.deleteGiftedRole(premiumMember);
				this.addBreadcrumb('Gifted role deleted');
			} catch (error) {
				this.addBreadcrumb('Failed to delete gifted role', { error: String(error) }, 'error');
				this.captureError(error as Error, 'deleteOrphanClan: deleteGiftedRole failed');
			}
		} else {
			// No premium owner row resolved (e.g. it was already removed by another path), but the clan
			// is being deleted, so its role must not survive. Delete it directly as a safety net.
			this.addBreadcrumb(
				'No premium member found; deleting clan role directly',
				{ customRoleId: clan.customRoleId },
				'warning',
			);
			try {
				await this.guild.roles.delete(clan.customRoleId, 'Orphan clan deleted; no premium owner entry found');
				this.addBreadcrumb('Clan role deleted directly', { customRoleId: clan.customRoleId });
			} catch (error) {
				this.addBreadcrumb(
					'Failed to delete clan role directly',
					{ error: String(error), customRoleId: clan.customRoleId },
					'error',
				);
				this.captureError(error as Error, 'deleteOrphanClan: direct role delete failed');
			}
		}

		if (this.userId) {
			try {
				this.addBreadcrumb('Cleaning up remaining clan member entries');
				await container.prisma.clanMember.deleteMany({
					where: { clanGuildId: this.guildId, userId: this.userId },
				});
				this.addBreadcrumb('Clan member entries cleaned up');
			} catch (error) {
				this.addBreadcrumb('Failed to clean up clan member entries', { error: String(error) }, 'error');
				this.captureError(error as Error, 'deleteOrphanClan: clanMember cleanup failed');
			}

			this.log(`Removed every clan member after clan deletion`);
		}

		this.addBreadcrumb('deleteOrphanClan completed');
	}

	public static async deletePremiumRole(premiumMember: PremiumMember): Promise<void> {
		const logPrefix = `[PREMIUM @${premiumMember.userId}@&${premiumMember.customRoleId}]`;
		const tags = {
			userId: premiumMember.userId,
			guildId: premiumMember.guildId,
			customRoleId: premiumMember.customRoleId ?? 'none',
		};

		Sentry.addBreadcrumb({
			category: 'clan',
			message: `${logPrefix} Starting deletePremiumRole`,
			level: 'info',
			data: tags,
		});

		const guild = container.client.guilds.cache.get(premiumMember.guildId);

		if (!guild || !premiumMember?.customRoleId) {
			Sentry.addBreadcrumb({
				category: 'clan',
				message: `${logPrefix} deletePremiumRole skipped: guild not found or no custom role`,
				level: 'warning',
				data: { ...tags, hasGuild: Boolean(guild), hasCustomRoleId: Boolean(premiumMember?.customRoleId) },
			});
			return;
		}

		try {
			await guild.roles.delete(
				premiumMember.customRoleId,
				'Member who created custom role either left the server or lost premium role',
			);

			container.logger.info(`${logPrefix} Deleted custom premium role (Discord)`);
			Sentry.addBreadcrumb({
				category: 'clan',
				message: `${logPrefix} Deleted custom premium role (Discord)`,
				level: 'info',
				data: tags,
			});
			await recordClanEvent({
				guildId: premiumMember.guildId,
				customRoleId: premiumMember.customRoleId,
				ownerUserId: premiumMember.userId,
				eventType: 'PremiumRoleDeleted',
			});
		} catch (error) {
			container.logger.error(`${logPrefix} Failed to delete custom premium role`, {
				userId: premiumMember.userId,
				guildId: premiumMember.guildId,
				error,
			});
			Sentry.addBreadcrumb({
				category: 'clan',
				message: `${logPrefix} Failed to delete custom premium role`,
				level: 'error',
				data: { ...tags, error: String(error) },
			});
			Sentry.withScope((scope) => {
				scope.setTags(tags);
				scope.setTag('operation', 'deletePremiumRole');
				Sentry.captureException(error);
			});
		}

		try {
			await container.prisma.premiumMember.update({
				where: { guildId_userId: { guildId: premiumMember.guildId, userId: premiumMember.userId } },
				data: { customRoleId: null },
			});

			container.logger.info(`${logPrefix} Deleted custom premium role (database)`);
			Sentry.addBreadcrumb({
				category: 'clan',
				message: `${logPrefix} Deleted custom premium role (database)`,
				level: 'info',
				data: tags,
			});
		} catch (error) {
			Sentry.addBreadcrumb({
				category: 'clan',
				message: `${logPrefix} Failed to update database after role deletion`,
				level: 'error',
				data: { ...tags, error: String(error) },
			});
			Sentry.withScope((scope) => {
				scope.setTags(tags);
				scope.setTag('operation', 'deletePremiumRole');
				scope.setExtra('context', 'database update after Discord role deletion');
				Sentry.captureException(error);
			});
		}
	}

	public static async deleteGiftedRole(premiumMember: PremiumMember): Promise<void> {
		const logPrefix = `[PREMIUM @${premiumMember.userId}@&${premiumMember.customRoleId}]`;
		const tags = {
			userId: premiumMember.userId,
			guildId: premiumMember.guildId,
			giftedToUserId: premiumMember.giftedRoleToUserId ?? 'none',
		};

		Sentry.addBreadcrumb({
			category: 'clan',
			message: `${logPrefix} Starting deleteGiftedRole`,
			level: 'info',
			data: tags,
		});

		const guild = container.client.guilds.cache.get(premiumMember.guildId);
		const guildConfig = await container.prisma.premiumGuildRoleConfig.findFirst({
			where: { guildId: premiumMember.guildId },
		});

		if (!guild || !premiumMember?.giftedRoleToUserId || !guildConfig?.legendRoleId) {
			Sentry.addBreadcrumb({
				category: 'clan',
				message: `${logPrefix} deleteGiftedRole skipped: missing data`,
				level: 'warning',
				data: {
					...tags,
					hasGuild: Boolean(guild),
					hasGiftedUserId: Boolean(premiumMember?.giftedRoleToUserId),
					hasLegendRoleId: Boolean(guildConfig?.legendRoleId),
				},
			});
			return;
		}

		const giftedUser = await guild.members.fetch(premiumMember.giftedRoleToUserId).catch(() => null);

		if (giftedUser) {
			try {
				await giftedUser.roles.remove(guildConfig.legendRoleId, 'Original premium member left server');
				container.logger.info(`${logPrefix} Deleted gifted role (Discord)`);
				Sentry.addBreadcrumb({
					category: 'clan',
					message: `${logPrefix} Deleted gifted role (Discord)`,
					level: 'info',
					data: { ...tags, giftedUserId: giftedUser.id },
				});
				if (premiumMember.customRoleId) {
					await recordClanEvent({
						guildId: premiumMember.guildId,
						customRoleId: premiumMember.customRoleId,
						ownerUserId: premiumMember.userId,
						targetUserId: premiumMember.giftedRoleToUserId,
						eventType: 'GiftedRoleRevoked',
						metadata: { legendRoleId: guildConfig.legendRoleId },
					});
				}
			} catch (error) {
				container.logger.error(`${logPrefix} Failed to remove gifted role`, {
					userId: giftedUser.id,
					guildId: premiumMember.guildId,
					giftedBy: premiumMember.userId,
					error,
				});
				Sentry.addBreadcrumb({
					category: 'clan',
					message: `${logPrefix} Failed to remove gifted role`,
					level: 'error',
					data: { ...tags, giftedUserId: giftedUser.id, error: String(error) },
				});
				Sentry.withScope((scope) => {
					scope.setTags(tags);
					scope.setTag('operation', 'deleteGiftedRole');
					Sentry.captureException(error);
				});
			}
		} else {
			Sentry.addBreadcrumb({
				category: 'clan',
				message: `${logPrefix} Gifted user not found in guild`,
				level: 'warning',
				data: tags,
			});
		}

		try {
			await container.prisma.premiumMember.update({
				where: { guildId_userId: { guildId: premiumMember.guildId, userId: premiumMember.userId } },
				data: { giftedRoleToUserId: null },
			});

			container.logger.info(`${logPrefix} Deleted gifted role (database)`);
			Sentry.addBreadcrumb({
				category: 'clan',
				message: `${logPrefix} Deleted gifted role (database)`,
				level: 'info',
				data: tags,
			});
		} catch (error) {
			Sentry.addBreadcrumb({
				category: 'clan',
				message: `${logPrefix} Failed to update database after gifted role removal`,
				level: 'error',
				data: { ...tags, error: String(error) },
			});
			Sentry.withScope((scope) => {
				scope.setTags(tags);
				scope.setTag('operation', 'deleteGiftedRole');
				scope.setExtra('context', 'database update after gifted role removal');
				Sentry.captureException(error);
			});
		}
	}

	public async inviteMember(
		memberId: string,
		force = false,
		options?: { actorUserId?: string; recordHistory?: boolean },
	): Promise<ClanMemberAddStatus> {
		this.addBreadcrumb('Starting inviteMember', { invitedMemberId: memberId, force });

		const clan = await this.getClan();

		if (!clan) {
			this.addBreadcrumb('inviteMember failed: clan not found', { invitedMemberId: memberId }, 'warning');
			return ClanMemberAddStatus.ClanNotFound;
		}

		const clanMembers = await this.getDiscordClanMembers();

		if (clanMembers.has(memberId) && !force) {
			this.addBreadcrumb('inviteMember skipped: already in clan', { invitedMemberId: memberId });
			return ClanMemberAddStatus.AlreadyInClan;
		}

		const invitedMember = await this.guild.members.fetch(memberId).catch(() => {});

		if (!invitedMember) {
			this.addBreadcrumb('inviteMember failed: member not found', { invitedMemberId: memberId }, 'warning');
			return ClanMemberAddStatus.InvitedMemberNotFound;
		}

		const customRoleId = await this.getCustomRoleId();
		const clanChannel = await this.getClanChannel();

		this.addBreadcrumb('Adding permission overwrite for member', {
			invitedMemberId: memberId,
			channelId: clanChannel?.id,
		});
		const addedToChannel = await clanChannel?.permissionOverwrites
			.create(invitedMember, {
				ViewChannel: true,
			})
			.then(() => true)
			.catch(async (error) => {
				this.addBreadcrumb(
					'Failed to add permission overwrite',
					{ invitedMemberId: memberId, error: String(error) },
					'error',
				);
				this.captureWarning(`Failed to add permission overwrite for member ${memberId}`, {
					error: String(error),
				});
				return false;
			});

		if (!addedToChannel) {
			this.addBreadcrumb('inviteMember failed: could not add to channel', { invitedMemberId: memberId }, 'error');
			return ClanMemberAddStatus.CouldNotAddToChannel;
		}

		this.addBreadcrumb('Permission overwrite added successfully', { invitedMemberId: memberId });

		if (!clanMembers.has(memberId)) {
			try {
				this.addBreadcrumb('Creating clan member entry in database', { invitedMemberId: memberId });
				await container.prisma.clanMember.create({
					data: {
						clanGuildId: clan.guildId,
						clanCustomRoleId: clan.customRoleId,
						userId: invitedMember.id,
						claimedRole: true,
					},
				});
				this.addBreadcrumb('Clan member entry created', { invitedMemberId: memberId });

				if (options?.recordHistory !== false) {
					await recordClanEvent({
						guildId: clan.guildId,
						customRoleId: clan.customRoleId,
						clanName: this.customRole?.name ?? this.clanChannel?.name ?? null,
						ownerUserId: this.getClanOwnerId() ?? null,
						actorUserId: options?.actorUserId ?? null,
						targetUserId: invitedMember.id,
						eventType: 'MemberJoined',
					});
				}
			} catch (error) {
				this.addBreadcrumb(
					'Failed to create clan member entry',
					{ invitedMemberId: memberId, error: String(error) },
					'error',
				);
				this.captureError(error as Error, 'inviteMember: database insert failed', {
					invitedMemberId: memberId,
				});
			}
		}

		try {
			this.addBreadcrumb('Adding clan role to member', { invitedMemberId: memberId, roleId: customRoleId });
			await invitedMember.roles.add(customRoleId!);
			this.addBreadcrumb('Clan role added successfully', { invitedMemberId: memberId });
		} catch (error) {
			this.addBreadcrumb(
				'Failed to add clan role to member',
				{ invitedMemberId: memberId, error: String(error) },
				'error',
			);
			this.captureError(error as Error, 'inviteMember: role add failed', {
				invitedMemberId: memberId,
				roleId: customRoleId,
			});
		}

		this.invalidateCache('clanMembers');

		this.addBreadcrumb('inviteMember completed', { invitedMemberId: memberId });
		return ClanMemberAddStatus.Added;
	}

	public async removeMember(
		member: GuildMember,
		context?: { actorUserId?: string; reason?: string },
	): Promise<ClanMemberRemoveStatus> {
		this.log(`Trying to remove member ${member.user.username} (${member.id})`);
		this.addBreadcrumb('Starting removeMember', { memberId: member.id, memberTag: member.user.tag });

		const clan = await this.getClan();

		if (!clan) {
			this.log(`Could not remove member ${member.user.username} (${member.id}): no clan found`);
			this.addBreadcrumb('removeMember failed: no clan found', { memberId: member.id }, 'error');
			this.captureWarning(`removeMember called but no clan found for member ${member.id}`);
			return ClanMemberRemoveStatus.ClanNotFound;
		}

		const customRoleId = await this.getCustomRoleId();
		const clanMembers = await this.getDiscordClanMembers();
		const clanChannel = await this.getClanChannel();

		await ensureFullMember(member);

		let roleRemoved = false;
		let permissionsRemoved = false;
		let databaseEntryRemoved = false;

		if (customRoleId && member.roles.cache.has(customRoleId)) {
			this.log(`Removing member ${member.user.username} (${member.id}): removing custom role first`);
			this.addBreadcrumb('Removing clan role from member', { memberId: member.id, roleId: customRoleId });
			try {
				await member.roles.remove(customRoleId);
				roleRemoved = true;
				this.log(`Removing member ${member.user.username} (${member.id}): removed custom role`);
				this.addBreadcrumb('Clan role removed from member', { memberId: member.id });
			} catch (error) {
				this.addBreadcrumb(
					'Failed to remove clan role from member',
					{ memberId: member.id, error: String(error) },
					'error',
				);
				this.logError(`Failed to remove role from member ${member.id}:`, error);
				this.captureError(error as Error, 'removeMember: role removal failed', {
					memberId: member.id,
					roleId: customRoleId,
				});
			}
		} else {
			this.addBreadcrumb('Member does not have clan role, skipping role removal', {
				memberId: member.id,
				roleId: customRoleId,
			});
			roleRemoved = true;
		}

		this.log(`Removing member ${member.user.username} (${member.id}): removing permission overwrites`);
		this.addBreadcrumb('Removing permission overwrites', { memberId: member.id, channelId: clanChannel?.id });
		try {
			await clanChannel?.permissionOverwrites.delete(member.id);
			permissionsRemoved = true;
			this.log(`Removing member ${member.user.username} (${member.id}): removed permission overwrites`);
			this.addBreadcrumb('Permission overwrites removed', { memberId: member.id });
		} catch (error) {
			this.addBreadcrumb(
				'Failed to remove permission overwrites',
				{ memberId: member.id, error: String(error) },
				'error',
			);
			this.logError(`Failed to remove permission overwrites for member ${member.id}:`, error);
			this.captureError(error as Error, 'removeMember: permission overwrite deletion failed', {
				memberId: member.id,
				channelId: clanChannel?.id,
			});
		}

		this.log(`Removing member ${member.user.username} (${member.id}): deleting clan member entry`);
		this.addBreadcrumb('Deleting clan member database entry', { memberId: member.id });
		try {
			await container.prisma.clanMember.delete({
				where: {
					clanGuildId_clanCustomRoleId_userId: {
						clanGuildId: clan!.guildId,
						clanCustomRoleId: clan!.customRoleId,
						userId: member.id,
					},
				},
			});
			databaseEntryRemoved = true;
			this.log(`Removing member ${member.user.username} (${member.id}): deleted clan member entry`);
			this.addBreadcrumb('Clan member database entry deleted', { memberId: member.id });
			await recordClanEvent({
				guildId: clan.guildId,
				customRoleId: clan.customRoleId,
				clanName: this.customRole?.name ?? this.clanChannel?.name ?? null,
				ownerUserId: this.getClanOwnerId() ?? null,
				actorUserId: context?.actorUserId ?? null,
				targetUserId: member.id,
				eventType: 'MemberLeft',
				reason: context?.reason ?? null,
			});
		} catch (error) {
			this.addBreadcrumb(
				'Failed to delete clan member database entry',
				{ memberId: member.id, error: String(error) },
				'error',
			);
			this.logError(`Failed to delete clan member entry for ${member.id}:`, error);
			this.captureError(error as Error, 'removeMember: database deletion failed', { memberId: member.id });
		}

		this.invalidateCache('clanMembers');

		const wasInClan = clanMembers.has(member.id);
		const result = wasInClan ? ClanMemberRemoveStatus.Removed : ClanMemberRemoveStatus.NotInClan;

		this.addBreadcrumb('removeMember completed', {
			memberId: member.id,
			roleRemoved,
			permissionsRemoved,
			databaseEntryRemoved,
			wasInClan,
			result,
		});

		if (!roleRemoved || !permissionsRemoved || !databaseEntryRemoved) {
			this.captureWarning(`removeMember completed with partial failures for member ${member.id}`, {
				roleRemoved,
				permissionsRemoved,
				databaseEntryRemoved,
			});
		}

		return result;
	}

	public async getCustomRoleId(): Promise<string | undefined> {
		if (!this.customRoleId) {
			this.addBreadcrumb('Resolving custom role ID');
			const premiumMember = await this.getPremiumMember();

			this.customRoleId = premiumMember?.customRoleId ?? this.userOrCustomRoleId;
			this.addBreadcrumb('getCustomRoleId: resolved', {
				customRoleId: this.customRoleId ?? 'none',
				source: premiumMember?.customRoleId ? 'premiumMember' : 'userOrCustomRoleId',
			});
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
		this.addBreadcrumb('Starting createClanChannel');

		const customRole = await this.getCustomRole();

		if (!customRole || !this.getClanOwnerId()) {
			this.addBreadcrumb(
				'createClanChannel skipped: missing role or owner',
				{ hasRole: Boolean(customRole), hasOwner: Boolean(this.getClanOwnerId()) },
				'warning',
			);
			return;
		}

		const clanCategory = await this.getClanCategory();

		if (!clanCategory) {
			this.addBreadcrumb('createClanChannel failed: no clan category configured', undefined, 'error');
			return;
		}

		this.addBreadcrumb('Creating Discord channel', {
			roleName: customRole.name,
			categoryId: clanCategory.id,
		});
		const clanChannel = await this.guild.channels
			.create({
				name: customRole.name,
				type: ChannelType.GuildText,
				parent: clanCategory.id,
				topic: 'Clan channel for ' + customRole.name,
				reason: 'Creating clan channel for ' + this.userId,
			})
			.catch(async (error) => {
				this.logError(`Clan channel creation failed: `, error);
				this.addBreadcrumb('Failed to create Discord channel', { error: String(error) }, 'error');
				this.captureError(error as Error, 'createClanChannel: channel creation failed');
			});

		if (!clanChannel) {
			return;
		}

		this.addBreadcrumb('Discord channel created', { channelId: clanChannel.id });

		let errorHappened = false;

		await clanChannel.lockPermissions().catch(async (error) => {
			errorHappened = true;
			this.logError(`Clan channel permissions locking failed: `, error);
			this.addBreadcrumb('Failed to lock channel permissions', { error: String(error) }, 'error');
			this.captureError(error as Error, 'createClanChannel: lockPermissions failed');
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
			.catch(async (error) => {
				errorHappened = true;
				this.logError(`Clan channel permissions setting for @everyone failed: `, error);
				this.addBreadcrumb('Failed to set @everyone permissions', { error: String(error) }, 'error');
				this.captureError(error as Error, 'createClanChannel: @everyone permissions failed');
			});

		await this.giveOwnerPermissions(clanChannel, this.getClanOwnerId()!).catch(async (error: Error) => {
			errorHappened = true;
			this.logError(`Clan channel permissions setting for owner failed: `, error);
			this.addBreadcrumb('Failed to set owner permissions', { error: String(error) }, 'error');
			this.captureError(error, 'createClanChannel: owner permissions failed');
		});

		if (errorHappened) {
			this.addBreadcrumb('Deleting channel due to permission errors', { channelId: clanChannel.id }, 'warning');
			try {
				await clanChannel.delete();
				this.addBreadcrumb('Channel deleted after permission errors');
			} catch (deleteError) {
				this.addBreadcrumb(
					'Failed to delete channel after permission errors',
					{ error: String(deleteError) },
					'error',
				);
				this.captureError(deleteError as Error, 'createClanChannel: cleanup deletion failed');
			}

			return;
		}

		this.addBreadcrumb('createClanChannel completed', { channelId: clanChannel.id });
		return clanChannel;
	}

	private async giveOwnerPermissions(channel: TextChannel, ownerId: string): Promise<NonThreadGuildBasedChannel> {
		return channel.permissionOverwrites.edit(
			ownerId,
			{
				ViewChannel: true,
				ManageChannels: true,
				ManageMessages: true,
				PinMessages: true,
				CreatePrivateThreads: true,
				MentionEveryone: true,
			},
			{ type: OverwriteType.Member },
		);
	}

	public async editChannelPermission(
		target: ClanPermissionEditTarget,
		permission: string,
		action: boolean | null,
	): Promise<{ error?: string; status: ClanPermissionEditStatus }> {
		this.addBreadcrumb('Starting editChannelPermission', { target, permission, action });

		const channel = await this.getClanChannel();
		if (!channel) {
			this.addBreadcrumb('editChannelPermission: no channel', undefined, 'warning');
			return { status: ClanPermissionEditStatus.NoChannel };
		}

		let targetId: string;
		let overwriteType: OverwriteType;
		if (target === ClanPermissionEditTarget.Owner) {
			let ownerId = this.getClanOwnerId();
			if (!ownerId) {
				await this.getPremiumMember();
				ownerId = this.getClanOwnerId();
			}

			if (!ownerId) {
				this.addBreadcrumb('editChannelPermission: no owner', undefined, 'warning');
				return { status: ClanPermissionEditStatus.NoOwner };
			}

			targetId = ownerId;
			overwriteType = OverwriteType.Member;
		} else {
			targetId = this.guild.roles.everyone.id;
			overwriteType = OverwriteType.Role;
		}

		try {
			await channel.permissionOverwrites.edit(targetId, { [permission]: action }, { type: overwriteType });
			this.addBreadcrumb('editChannelPermission completed', { targetId, permission, action });
			return { status: ClanPermissionEditStatus.Success };
		} catch (error) {
			if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownPermissionOverwrite) {
				this.addBreadcrumb('editChannelPermission: owner not in guild', { targetId }, 'warning');
				return { status: ClanPermissionEditStatus.OwnerNotInGuild };
			}

			const errorMessage = String(error);
			this.addBreadcrumb('editChannelPermission failed', { error: errorMessage }, 'error');
			this.logError('editChannelPermission failed:', error);
			this.captureError(error as Error, 'editChannelPermission failed');
			return { error: errorMessage, status: ClanPermissionEditStatus.Error };
		}
	}

	private async getPremiumMember(): Promise<PremiumMember | null> {
		if (this.premiumMember === undefined) {
			this.addBreadcrumb('Fetching premium member from database');
			const lookupId = this.getClanOwnerId() ?? this.userOrCustomRoleId;

			if (!lookupId) {
				this.addBreadcrumb('getPremiumMember: no lookup id available', undefined, 'warning');
				this.premiumMember = null;
				return null;
			}

			try {
				// The string constructor is ambiguous (it accepts either a userId or a customRoleId), so
				// resolve against both columns. User IDs and role IDs are disjoint snowflake spaces, so a
				// single id can only match the intended owner regardless of which one we were built from.
				this.premiumMember = await container.prisma.premiumMember.findFirst({
					where: { guildId: this.guildId, OR: [{ userId: lookupId }, { customRoleId: lookupId }] },
				});
				this.addBreadcrumb('getPremiumMember: database query completed', {
					found: Boolean(this.premiumMember),
					lookupId,
					hasCustomRole: Boolean(this.premiumMember?.customRoleId),
				});
			} catch (error) {
				this.addBreadcrumb(
					'getPremiumMember: database query failed',
					{ error: String(error), lookupId },
					'error',
				);
				this.captureError(error as Error, 'getPremiumMember: database query failed');
				return null;
			}
		}

		// Once the owner row is resolved, backfill both identifiers so callers built from a role ID can
		// still resolve the owner's user ID (and vice versa).
		if (this.premiumMember) {
			this.userId ??= this.premiumMember.userId;
			this.customRoleId ??= this.premiumMember.customRoleId ?? undefined;
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

	private getLogPrefix(): string {
		// Use cached values directly to avoid circular calls (getters add breadcrumbs which call this)
		const ids = [
			{ prefix: '@', id: this.getClanOwnerId() },
			{ prefix: '@&', id: this.customRoleId ?? this.userOrCustomRoleId },
			{ prefix: '#', id: this.clanChannel?.id },
			{ prefix: '*', id: this.guildId },
		]
			.map((element) => `${element.id ? `${element.prefix}${element.id}` : ''}`)
			.join('');

		return `${LogPrefix.CLAN} [${ids}] `;
	}

	private doLog(log: readonly unknown[], level: Exclude<keyof ILogger, 'has' | 'write'> = 'info'): void {
		container.logger[level](this.getLogPrefix(), ...log);
	}

	private log(...log: readonly unknown[]): void {
		this.doLog(log);
	}

	private logError(...log: readonly unknown[]): void {
		this.doLog(log, 'error');
	}

	private getSentryTags(): Record<string, string> {
		// Use cached values directly to avoid circular calls (getters add breadcrumbs which call this)
		return {
			userId: this.getClanOwnerId() ?? 'unknown',
			guildId: this.guildId,
			customRoleId: this.customRoleId ?? this.userOrCustomRoleId ?? 'unknown',
			clanChannelId: this.clanChannel?.id ?? 'unknown',
		};
	}

	private addBreadcrumb(message: string, data?: Record<string, unknown>, level: Sentry.SeverityLevel = 'info'): void {
		const tags = this.getSentryTags();
		Sentry.addBreadcrumb({
			category: 'clan',
			message: `${this.getLogPrefix()}${message}`,
			level,
			data: { ...tags, ...data },
		});
	}

	private captureError(error: Error | string, context?: string, extra?: Record<string, unknown>): void {
		const tags = this.getSentryTags();
		const errorMessage = error instanceof Error ? error : new Error(error);

		Sentry.withScope((scope) => {
			scope.setTags(tags);
			scope.setTag('operation', 'clan');
			if (context) {
				scope.setExtra('context', context);
			}

			if (extra) {
				scope.setExtras(extra);
			}

			Sentry.captureException(errorMessage);
		});
	}

	private captureWarning(message: string, extra?: Record<string, unknown>): void {
		const tags = this.getSentryTags();
		const logPrefix = this.getLogPrefix();

		Sentry.withScope((scope) => {
			scope.setTags(tags);
			scope.setTag('operation', 'clan');
			scope.setLevel('warning');
			if (extra) {
				scope.setExtras(extra);
			}

			Sentry.captureMessage(`${logPrefix}${message}`, 'warning');
		});
	}
}
