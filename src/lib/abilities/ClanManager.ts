import type { Clan, ClanMember, PremiumMember } from '@prisma/client';
import { container } from '@sapphire/framework';
import { ChannelType } from 'discord-api-types/v10';
import type { CategoryChannel, GuildMember, Role, TextChannel } from 'discord.js';
import { Collection } from 'discord.js';
import { MemberAbilities } from './MemberAbilities.js';

export const MAX_MEMBERS_IN_CLAN = 40;

export enum ClanCreationAbilityStatus {
    Able = 0,
    NotAble = 1,
    AbleButNoCustomRole = 2,
}

export enum ClanCreationStatus {
    Created = 0,
    CategoryNotConfigured = 1,
    NotAble = 2,
    AbleButNoCustomRole = 3,
    CustomRoleNotFound = 4,
    ExistingClanFound = 5,
    CouldNotCreateClanChannel = 6,
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
    NotInClan = 1,
}

type CacheType = 'clan' | 'clanChannel' | 'clanMembers' | 'customRole' | 'premiumMember';

export class ClanManager {
    private readonly member: GuildMember;

    private premiumMember?: PremiumMember | null;

    private clan?: Clan | null;

    private clanChannel?: TextChannel | null;

    private customRole?: Role | null;

    private clanMembers?: Collection<string, ClanMember> | null;

    private discordClanMembers?: Collection<string, GuildMember> | null;

    public constructor(member: GuildMember) {
        this.member = member;
    }

    public static async fromChannel(channel: TextChannel): Promise<ClanManager | undefined> {
        const clan = await container.prisma.clan.findFirst({
            where: { guildId: channel.guildId, channelId: channel.id },
        });

        if (!clan) {
            return;
        }

        const premiumMember = await container.prisma.premiumMember.findFirst({
            where: { guildId: channel.guild.id, customRoleId: clan.customRoleId },
        });

        if (!premiumMember) {
            return;
        }

        return new ClanManager(await channel.guild.members.fetch(premiumMember.userId));
    }

    public async getClanCategory(): Promise<CategoryChannel | undefined> {
        const guildConfig = await container.prisma.premiumGuildRoleConfig.findFirst({
            where: { guildId: this.member.guild.id },
        });

        if (!guildConfig?.clanCategoryId) {
            return;
        }

        return (await this.member.guild.channels.fetch(guildConfig.clanCategoryId).catch(() => {})) as CategoryChannel ?? undefined;
    }

    public getClanOwner(): GuildMember {
        return this.member;
    }

    public async getClanInvitesChannel(): Promise<TextChannel | undefined> {
        const guildConfig = await container.prisma.premiumGuildRoleConfig.findFirst({
            where: { guildId: this.member.guild.id },
        });

        if (!guildConfig?.clanInviteChannelId) {
            return;
        }

        return (await this.member.guild.channels.fetch(guildConfig.clanInviteChannelId).catch(() => {})) as TextChannel ?? undefined;
    }

    public async canCreateClan(): Promise<ClanCreationAbilityStatus> {
        const customRoleId = await this.getCustomRoleId();

        const memberAbilities = new MemberAbilities(this.member);
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
                where: { guildId: this.member.guild.id, customRoleId },
            });
        }

        return this.clan;
    }

    public async getClanChannel(): Promise<TextChannel | null | undefined> {
        if (this.clanChannel === undefined) {
            const clan = await this.getClan();

            if (!clan) {
                return;
            }

            const channel = await this.member.guild.channels.fetch(clan.channelId).catch(() => {});

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

            this.customRole = await this.member.guild.roles.fetch(customRoleId).catch(() => {}) ?? null;
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
                const member = await this.member.guild.members.fetch(clanMember.userId).catch(() => {});

                if (member) {
                    collection.set(clanMember.userId, member);
                }
            }

            this.discordClanMembers = collection;
        }

        return this.discordClanMembers ?? new Collection<string, GuildMember>();
    }

    public async createClan(): Promise<ClanCreationStatus> {
        const clanCategory = await this.getClanCategory();

        if (!clanCategory) {
            return ClanCreationStatus.CategoryNotConfigured;
        }

        const clanCreationAbility = await this.canCreateClan();

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

        container.logger.info(`[CLAN] Creating clan channel ${customRole.name} for ${this.member.id}...`);

        const clanChannel = await this.createClanChannel();

        if (!clanChannel) {
            return ClanCreationStatus.CouldNotCreateClanChannel;
        }

        const clan = await container.prisma.clan.create({
            data: {
                guildId: this.member.guild.id,
                customRoleId: customRole.id,
                channelId: clanChannel.id,
            },
        });

        await container.prisma.clanMember.create({
            data: {
                clanGuildId: clan!.guildId,
                clanCustomRoleId: clan!.customRoleId,
                userId: this.member.id,
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

    public async inviteMember(memberId: string): Promise<ClanMemberAddStatus> {
        const clan = await this.getClan();

        if (!clan) {
            return ClanMemberAddStatus.ClanNotFound;
        }

        const clanMembers = await this.getDiscordClanMembers();

        if (clanMembers.has(memberId)) {
            return ClanMemberAddStatus.AlreadyInClan;
        }

        const invitedMember = await this.member.guild.members.fetch(memberId).catch(() => {});

        if (!invitedMember) {
            return ClanMemberAddStatus.InvitedMemberNotFound;
        }

        const customRoleId = await this.getCustomRoleId();
        const clanChannel = await this.getClanChannel();
        const addedToChannel = await clanChannel?.permissionOverwrites.create(invitedMember, {
            ViewChannel: true,
        }).then(() => true).catch(() => false);

        if (!addedToChannel) {
            return ClanMemberAddStatus.CouldNotAddToChannel;
        }

        await container.prisma.clanMember.create({
            data: {
                clanGuildId: clan.guildId,
                clanCustomRoleId: clan.customRoleId,
                userId: invitedMember.id,
                claimedRole: true,
            },
        });

        await invitedMember.roles.add(customRoleId!);

        this.invalidateCache('clanMembers')

        return ClanMemberAddStatus.Added;
    }

    public async removeMember(member: GuildMember): Promise<ClanMemberRemoveStatus> {
        const clan = await this.getClan();
        const premiumMember = await this.getPremiumMember();
        const clanMembers = await this.getDiscordClanMembers();
        const clanChannel = await this.getClanChannel();

        if (premiumMember?.customRoleId && member.roles.cache.has(premiumMember.customRoleId)) {
            await member.roles.remove(premiumMember.customRoleId);
        }

        await clanChannel?.permissionOverwrites.delete(member.id);
        await container.prisma.clanMember.delete({
            where: { clanGuildId_clanCustomRoleId_userId: {
                clanGuildId: clan!.guildId,
                clanCustomRoleId: clan!.customRoleId,
                userId: member.id,
            } }
        });

        this.invalidateCache('clanMembers');

        return clanMembers.has(member.id) ? ClanMemberRemoveStatus.Removed : ClanMemberRemoveStatus.NotInClan;
    }

    public invalidateCache(type: CacheType): void {
        this[type] = undefined;

        if (type === 'clanMembers') {
            this.discordClanMembers = undefined;
        }
    }

    private async createClanChannel(): Promise<TextChannel | undefined> {
        const customRole = await this.getCustomRole();

        if (!customRole) {
            return;
        }

        const clanCategory = await this.getClanCategory();

        if (!clanCategory) {
            return;
        }

        const clanChannel = await this.member.guild.channels.create({
            name: customRole.name,
            type: ChannelType.GuildText,
            parent: clanCategory.id,
            topic: 'Clan channel for ' + customRole.name,
            reason: 'Creating clan channel for ' + this.member.user.username,
        }).catch(error => container.logger.debug(error));

        if (!clanChannel) {
            return;
        }

        await clanChannel.lockPermissions().catch(error => container.logger.debug(error));
        await clanChannel.permissionOverwrites.edit(this.member.guild.roles.everyone.id, {
            ViewChannel: false,
            CreatePublicThreads: true,
        }).catch(error => container.logger.debug(error));
        await clanChannel.permissionOverwrites.edit(this.member.id, {
            ViewChannel: true,
            ManageChannels: true,
            ManageMessages: true,
            CreatePrivateThreads: true,
        }).catch(error => container.logger.debug(error));

        return clanChannel;
    }

    private async getPremiumMember(): Promise<PremiumMember | null> {
        if (this.premiumMember === undefined) {
            this.premiumMember = await container.prisma.premiumMember.findFirst({
                where: { guildId: this.member.guild.id, userId: this.member.id },
            });
        }

        return this.premiumMember;
    }

    private async getCustomRoleId(): Promise<string | undefined> {
        const premiumMember = await this.getPremiumMember();

        return premiumMember?.customRoleId ?? undefined;
    }
}
