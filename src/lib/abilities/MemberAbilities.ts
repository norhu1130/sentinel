import type { GuildMember } from 'discord.js';
import type { RoleAbilities, RoleAbility } from './RoleAbilities.js';
import { RoleAbilitiesCalculator } from './RoleAbilities.js';

export class MemberAbilities {
	private readonly member: GuildMember;

	private readonly roleAbilities: RoleAbilitiesCalculator;

	private abilitiesComputed: boolean;

	private abilities: RoleAbilities = {
		canCreateClan: false,
		canCreateCustomRole: false,
		canGiftLegend: false,
	};

	public constructor(member: GuildMember) {
		this.member = member;
		this.roleAbilities = new RoleAbilitiesCalculator(member.guild.id);
		this.abilitiesComputed = false;
	}

	public async computeAbilities() {
		await this.roleAbilities.computeList();

		const hasPremiumRole = this.roleAbilities
			.getAllPremiumRoleIds()
			.some((roleId) => this.member.roles.cache.has(roleId));

		if (!hasPremiumRole) {
			this.abilitiesComputed = true;
			return;
		}

		// eslint-disable-next-line unicorn/consistent-function-scoping
		const hasRole = (roleId: string) => this.member.roles.cache.has(roleId);

		this.abilities.canCreateClan = this.roleAbilities.getPremiumRoleIds('canCreateClan').some(hasRole);
		this.abilities.canCreateCustomRole = this.roleAbilities.getPremiumRoleIds('canCreateCustomRole').some(hasRole);
		this.abilities.canGiftLegend = this.roleAbilities.getPremiumRoleIds('canGiftLegend').some(hasRole);

		this.abilitiesComputed = true;
	}

	public areAbilitiesComputed() {
		return this.abilitiesComputed;
	}

	public hasAbility(ability: RoleAbility): boolean {
		if (!this.areAbilitiesComputed()) {
			throw new Error('Member abilities must be computed first');
		}

		return this.abilities[ability];
	}

	public hasEqualAbilities(other: MemberAbilities): boolean {
		for (const ability in this.abilities) {
			if (this.hasAbility(ability as RoleAbility) !== other.hasAbility(ability as RoleAbility)) {
				return false;
			}
		}

		return true;
	}

	public hasNone(): boolean {
		if (!this.areAbilitiesComputed()) {
			throw new Error('Member abilities must be computed first');
		}

		for (const ability in this.abilities) {
			if (this.hasAbility(ability as RoleAbility)) {
				return false;
			}
		}

		return true;
	}
}
