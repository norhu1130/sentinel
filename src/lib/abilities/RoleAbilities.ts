import { container } from '@sapphire/framework';

export class RoleAbilitiesCalculator {
	private readonly guildId: string;

	private allPremiumRoleIds: string[];

	private premiumRoleIds: Record<RoleAbility, string[]> = {
		canCreateClan: [],
		canCreateCustomRole: [],
		canGiftLegend: [],
		areAbilitiesMultiGuild: [],
		canUploadCustomEmoji: [],
		canPickSubscriberRole: [],
		canCreateCustomCommand: [],
	};

	public constructor(guildId: string) {
		this.guildId = guildId;
		this.allPremiumRoleIds = [];
	}

	public async computeList() {
		const allPremiumRoles = await container.prisma.roleAbilities.findMany({
			where: { guildId: this.guildId },
		});

		this.allPremiumRoleIds = allPremiumRoles.map((result) => result.roleId);

		this.premiumRoleIds = {
			canGiftLegend: allPremiumRoles.filter((role) => role.canGiftLegend).map((result) => result.roleId),
			canCreateCustomRole: allPremiumRoles
				.filter((role) => role.canCreateCustomRole)
				.map((result) => result.roleId),
			canCreateClan: allPremiumRoles.filter((role) => role.canCreateClan).map((result) => result.roleId),
			areAbilitiesMultiGuild: allPremiumRoles
				.filter((role) => role.areAbilitiesMultiGuild)
				.map((result) => result.roleId),
			canUploadCustomEmoji: allPremiumRoles
				.filter((role) => role.canUploadCustomEmoji)
				.map((result) => result.roleId),
			canPickSubscriberRole: allPremiumRoles
				.filter((role) => role.canPickSubscriberRole)
				.map((result) => result.roleId),
			canCreateCustomCommand: allPremiumRoles
				.filter((role) => role.canCreateCustomCommand)
				.map((result) => result.roleId),
		};
	}

	public getAllPremiumRoleIds() {
		return this.allPremiumRoleIds;
	}

	public getPremiumRoleIds(ability: RoleAbility): string[];
	public getPremiumRoleIds(): Record<RoleAbility, string[]>;
	public getPremiumRoleIds(ability?: RoleAbility): Record<RoleAbility, string[]> | string[] {
		if (!ability) {
			return this.premiumRoleIds;
		}

		return this.premiumRoleIds[ability];
	}

	public getRoleAbilities(roleId: string): RoleAbilities {
		return {
			canCreateClan: this.premiumRoleIds.canCreateClan.includes(roleId),
			canCreateCustomRole: this.premiumRoleIds.canCreateCustomRole.includes(roleId),
			canGiftLegend: this.premiumRoleIds.canGiftLegend.includes(roleId),
			areAbilitiesMultiGuild: this.premiumRoleIds.areAbilitiesMultiGuild.includes(roleId),
			canUploadCustomEmoji: this.premiumRoleIds.canUploadCustomEmoji.includes(roleId),
			canPickSubscriberRole: this.premiumRoleIds.canPickSubscriberRole.includes(roleId),
			canCreateCustomCommand: this.premiumRoleIds.canCreateCustomCommand.includes(roleId),
		};
	}
}

export type RoleAbility =
	| 'areAbilitiesMultiGuild'
	| 'canCreateClan'
	| 'canCreateCustomCommand'
	| 'canCreateCustomRole'
	| 'canGiftLegend'
	| 'canPickSubscriberRole'
	| 'canUploadCustomEmoji';
export type RoleAbilities = Record<RoleAbility, boolean>;

export const RoleAbilityMap: Record<RoleAbility, string> = {
	canCreateClan: 'Can create clan',
	canCreateCustomRole: 'Can create custom role',
	canGiftLegend: 'Can gift legend',
	areAbilitiesMultiGuild: 'Can use abilities on multiple servers',
	canUploadCustomEmoji: 'Can upload custom emojis',
	canPickSubscriberRole: 'Can pick subscriber roles',
	canCreateCustomCommand: 'Can create custom commands',
};
