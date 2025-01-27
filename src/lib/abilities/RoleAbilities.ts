import { container } from '@sapphire/framework';

export class RoleAbilitiesCalculator {
	private readonly guildId: string;

	private allPremiumRoleIds: string[];

	private premiumRoleIds: Record<RoleAbility, string[]> = {
		canCreateClan: [],
		canCreateCustomRole: [],
		canGiftLegend: [],
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
		};
	}
}

export type RoleAbility = 'canCreateClan' | 'canCreateCustomRole' | 'canGiftLegend';
export type RoleAbilities = Record<RoleAbility, boolean>;

export const RoleAbilityMap: Record<RoleAbility, string> = {
	canCreateClan: 'Can create clan',
	canCreateCustomRole: 'Can create custom role',
	canGiftLegend: 'Can gift legend',
};
