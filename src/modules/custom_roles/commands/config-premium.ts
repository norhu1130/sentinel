import { Subcommand, type SubcommandMappingArray } from '@sapphire/plugin-subcommands';
import { remove } from 'confusables';
import { ChannelType } from 'discord-api-types/v10';
import { PermissionFlagsBits, escapeMarkdown, type Role, Message, TextChannel } from 'discord.js';
import type { RoleAbility } from '../../../lib/abilities/RoleAbilities.js';
import { RoleAbilitiesCalculator, RoleAbilityMap } from '../../../lib/abilities/RoleAbilities.js';
import { createErrorEmbed, createInfoEmbed } from '../../../lib/utils/createEmbed.js';

export class ConfigPremiumCommand extends Subcommand {
	public subcommandMappings: SubcommandMappingArray = [
		{
			type: 'method',
			name: 'show-config',
			chatInputRun: 'showConfigSubcommand',
		},
		{
			type: 'method',
			name: 'set-legend-role',
			chatInputRun: 'setLegendRoleSubcommand',
		},
		{
			type: 'method',
			name: 'set-clan-category',
			chatInputRun: 'setClanCategorySubcommand',
		},
		{
			type: 'method',
			name: 'set-clan-invites-channel',
			chatInputRun: 'setClanInvitesChannelSubcommand',
		},
		{
			type: 'group',
			name: 'role-abilities',
			entries: [
				{
					name: 'list',
					chatInputRun: 'listRoleAbilitiesSubcommand',
				},
				{
					name: 'add',
					chatInputRun: 'addRoleAbilitySubcommand',
				},
				{
					name: 'remove',
					chatInputRun: 'removeRoleAbilitySubcommand',
				},
			],
		},
		{
			type: 'method',
			name: 'set-position-role',
			chatInputRun: 'setPositionRoleSubcommand',
		},
		{
			type: 'group',
			name: 'staff-roles',
			entries: [
				{
					name: 'list',
					chatInputRun: 'listStaffRolesSubcommand',
				},
				{
					name: 'add',
					chatInputRun: 'addStaffRoleSubcommand',
				},
				{
					name: 'remove',
					chatInputRun: 'removeStaffRoleSubcommand',
				},
			],
		},
		{
			type: 'group',
			name: 'forbidden-names',
			entries: [
				{
					name: 'add',
					chatInputRun: 'addForbiddenNameSubcommand',
				},
				{
					name: 'remove',
					chatInputRun: 'removeForbiddenNameSubcommand',
				},
				{
					name: 'list',
					chatInputRun: 'listForbiddenNamesSubcommand',
				},
			],
		},

		{
			type: 'group',
			name: 'directory', // New group for directory settings
			entries: [
				{
					name: 'set-channel',
					chatInputRun: 'setDirectoryChannelSubcommand',
				},
			],
		},
	];

	public async showConfigSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		const premiumConfig = await this.container.prisma.premiumGuildRoleConfig.findFirst({
			where: { guildId: interaction.guildId },
		});

		const giftableRole =
			premiumConfig?.legendRoleId ? interaction.guild.roles.resolve(premiumConfig.legendRoleId) : null;

		const clanCategory =
			premiumConfig?.clanCategoryId ? interaction.guild.channels.resolve(premiumConfig.clanCategoryId) : null;

		const clanInviteChannel =
			premiumConfig?.clanInviteChannelId ?
				interaction.guild.channels.resolve(premiumConfig.clanInviteChannelId)
			:	null;

		const representations = [
			{ name: 'Giftable Role', value: giftableRole ? `<@&${giftableRole.id}> (${giftableRole.id})` : null },
			{ name: 'Clan Category', value: clanCategory ? `<#${clanCategory.id}> (${clanCategory.id})` : null },
			{
				name: 'Clan Invite Channel',
				value: clanInviteChannel ? `<#${clanInviteChannel.id}> (${clanInviteChannel.id})` : null,
			},
		];

		await interaction.reply({
			embeds: [
				createInfoEmbed(representations.map(({ name, value }) => `**${name}:** ${value ?? 'None'}`).join('\n')),
			],
			ephemeral: true,
		});
	}

	public async setLegendRoleSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		const role = interaction.options.getRole('role', false);

		if (role?.managed) {
			await interaction.reply({
				embeds: [createInfoEmbed('You cannot set a managed role as the legend role!')],
				ephemeral: true,
			});

			return;
		}

		const me = await interaction.guild.members.fetch(this.container.client.user!.id);

		if (role && me.roles.highest.position <= role.position) {
			await interaction.reply({
				ephemeral: true,
				embeds: [
					createInfoEmbed(
						`I do not have permission to assign the role ${role} in this server as its above my highest role.`,
					),
				],
			});

			return;
		}

		const existingPremiumConfig = await this.container.prisma.premiumGuildRoleConfig.findFirst({
			where: { guildId: interaction.guildId },
		});

		if (existingPremiumConfig) {
			const previousRole =
				existingPremiumConfig.legendRoleId ?
					interaction.guild.roles.resolve(existingPremiumConfig.legendRoleId)
				:	null;

			const previousRoleRepresentation = previousRole ? `<@&${previousRole.id}> (${previousRole.id})` : 'none';
			const newRoleRepresentation = role ? `<@&${role.id}> (${role.id})` : 'none';

			await this.container.prisma.premiumGuildRoleConfig.update({
				where: { guildId: interaction.guildId },
				data: { legendRoleId: role?.id ?? null },
			});

			await interaction.reply({
				embeds: [
					createInfoEmbed(
						`Set the legend role in this server from ${previousRoleRepresentation} to ${newRoleRepresentation}`,
					),
				],
				ephemeral: true,
			});

			return;
		}

		await this.container.prisma.premiumGuildRoleConfig.create({
			data: { guildId: interaction.guildId, legendRoleId: role?.id ?? null },
		});

		const newRoleRepresentation = role ? `<@&${role.id}> (${role.id})` : 'none';

		await interaction.reply({
			embeds: [createInfoEmbed(`Set the legend role in this server to ${newRoleRepresentation}`)],
			ephemeral: true,
		});
	}

	public async setClanCategorySubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		const category = interaction.options.getChannel('category', true);

		if (!category || category.type !== ChannelType.GuildCategory) {
			await interaction.reply({
				embeds: [createErrorEmbed('No category or invalid category provided.')],
				ephemeral: true,
			});

			return;
		}

		const existingPremiumConfig = await this.container.prisma.premiumGuildRoleConfig.findFirst({
			where: { guildId: interaction.guildId },
		});

		if (existingPremiumConfig) {
			const previousCategory =
				existingPremiumConfig.clanCategoryId ?
					interaction.guild.channels.resolve(existingPremiumConfig.clanCategoryId)
				:	null;

			const previousRepresentation =
				previousCategory ? `<#${previousCategory.id}> (${previousCategory.id})` : 'none';
			const newRepresentation = category ? `<#${category.id}> (${category.id})` : 'none';

			await this.container.prisma.premiumGuildRoleConfig.update({
				where: { guildId: interaction.guildId },
				data: { clanCategoryId: category.id ?? null },
			});

			await interaction.reply({
				embeds: [
					createInfoEmbed(`Set the clan category from ${previousRepresentation} to ${newRepresentation}`),
				],
				ephemeral: true,
			});

			return;
		}

		await this.container.prisma.premiumGuildRoleConfig.create({
			data: { guildId: interaction.guildId, clanCategoryId: category.id },
		});

		const newRepresentation = category ? `<#${category.id}> (${category.id})` : 'none';

		await interaction.reply({
			embeds: [createInfoEmbed(`Set the clan category to ${newRepresentation}`)],
			ephemeral: true,
		});
	}

	public async setClanInvitesChannelSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		const channel = interaction.options.getChannel('channel', true);

		if (!channel || channel.type !== ChannelType.GuildText) {
			await interaction.reply({
				embeds: [createErrorEmbed('No channel or invalid channel provided.')],
				ephemeral: true,
			});

			return;
		}

		const existingPremiumConfig = await this.container.prisma.premiumGuildRoleConfig.findFirst({
			where: { guildId: interaction.guildId },
		});

		if (existingPremiumConfig) {
			const previousChannel =
				existingPremiumConfig.clanInviteChannelId ?
					interaction.guild.channels.resolve(existingPremiumConfig.clanInviteChannelId)
				:	null;

			const previousRepresentation =
				previousChannel ? `<#${previousChannel.id}> (${previousChannel.id})` : 'none';
			const newRepresentation = channel ? `<#${channel.id}> (${channel.id})` : 'none';

			await this.container.prisma.premiumGuildRoleConfig.update({
				where: { guildId: interaction.guildId },
				data: { clanInviteChannelId: channel.id ?? null },
			});

			await interaction.reply({
				embeds: [
					createInfoEmbed(
						`Set the clan invites channel from ${previousRepresentation} to ${newRepresentation}`,
					),
				],
				ephemeral: true,
			});

			return;
		}

		await this.container.prisma.premiumGuildRoleConfig.create({
			data: { guildId: interaction.guildId, clanInviteChannelId: channel.id },
		});

		const newRepresentation = channel ? `<#${channel.id}> (${channel.id})` : 'none';

		await interaction.reply({
			embeds: [createInfoEmbed(`Set the clan invites channel to ${newRepresentation}`)],
			ephemeral: true,
		});
	}

	public async listRoleAbilitiesSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		const roleAbilitiesCalculator = new RoleAbilitiesCalculator(interaction.guildId);

		await roleAbilitiesCalculator.computeList();

		if (roleAbilitiesCalculator.getAllPremiumRoleIds().length < 1) {
			await interaction.reply({
				embeds: [createInfoEmbed('No role abilities were configured yet.')],
				ephemeral: true,
			});

			return;
		}

		const premiumRoles = roleAbilitiesCalculator
			.getAllPremiumRoleIds()
			.map((id) => interaction.guild.roles.resolve(id))
			.filter(Boolean)
			.filter((role) => {
				const abilities = roleAbilitiesCalculator.getRoleAbilities(role!.id);

				return Object.values(abilities).some(Boolean);
			}) as Role[];

		await interaction.reply({
			embeds: [
				createInfoEmbed(
					premiumRoles
						.map((role) => {
							const abilities = Object.entries(roleAbilitiesCalculator.getRoleAbilities(role.id))
								.filter(([_, value]) => value)
								.map(([key]) => `> - ${RoleAbilityMap[key as RoleAbility]}`);

							return `### ${role.toString()}\n> **Abilities:**\n${abilities.join('\n')}`;
						})
						.join('\n\n'),
				).setTitle('Role Abilities'),
			],
			ephemeral: true,
		});
	}

	public async addRoleAbilitySubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		const roleAbilitiesCalculator = new RoleAbilitiesCalculator(interaction.guildId);
		const role = interaction.options.getRole('role', true);
		const ability = interaction.options.getString('ability', true);
		await roleAbilitiesCalculator.computeList();
		const roleAbilities = roleAbilitiesCalculator.getRoleAbilities(role.id);

		if (!Object.keys(RoleAbilityMap).includes(ability as RoleAbility)) {
			await interaction.reply({
				embeds: [createInfoEmbed('This is not a valid ability.')],
				ephemeral: true,
			});

			return;
		}

		if (roleAbilities[ability as RoleAbility]) {
			await interaction.reply({
				embeds: [createInfoEmbed('This role already has this ability.')],
				ephemeral: true,
			});

			return;
		}

		await this.container.prisma.roleAbilities.upsert({
			where: { guildId_roleId: { guildId: interaction.guildId, roleId: role.id } },
			create: { guildId: interaction.guildId, roleId: role.id, [ability]: true },
			update: { [ability]: true },
		});

		await interaction.reply({
			embeds: [
				createInfoEmbed(
					`Added the ability "${RoleAbilityMap[ability as RoleAbility]}" to role ${role.toString()}.`,
				),
			],
			ephemeral: true,
		});
	}

	public async removeRoleAbilitySubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		const roleAbilitiesCalculator = new RoleAbilitiesCalculator(interaction.guildId);
		const role = interaction.options.getRole('role', true);
		const ability = interaction.options.getString('ability', true);
		await roleAbilitiesCalculator.computeList();
		const roleAbilities = roleAbilitiesCalculator.getRoleAbilities(role.id);

		if (!Object.keys(RoleAbilityMap).includes(ability as RoleAbility)) {
			await interaction.reply({
				embeds: [createInfoEmbed('That is not a valid ability.')],
				ephemeral: true,
			});

			return;
		}

		if (!roleAbilities[ability as RoleAbility]) {
			await interaction.reply({
				embeds: [createInfoEmbed('This role already does not have this ability.')],
				ephemeral: true,
			});

			return;
		}

		await this.container.prisma.roleAbilities.update({
			where: { guildId_roleId: { guildId: interaction.guildId, roleId: role.id } },
			data: { [ability]: false },
		});

		await interaction.reply({
			embeds: [
				createInfoEmbed(
					`Removed the ability "${RoleAbilityMap[ability as RoleAbility]}" from role ${role.toString()}.`,
				),
			],
			ephemeral: true,
		});
	}

	public async setPositionRoleSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		const role = interaction.options.getRole('role', false);
		const me = await interaction.guild.members.fetch(this.container.client.user!.id);

		if (role && me.roles.highest.position <= role.position) {
			await interaction.reply({
				ephemeral: true,
				embeds: [
					createInfoEmbed(
						`I do not have permission create roles above ${role} in this server as its above my highest role.`,
					),
				],
			});

			return;
		}

		const existingPremiumConfig = await this.container.prisma.premiumGuildRoleConfig.findFirst({
			where: { guildId: interaction.guildId },
		});

		if (existingPremiumConfig) {
			const previousRole =
				existingPremiumConfig.startingPositionRoleId ?
					interaction.guild.roles.resolve(existingPremiumConfig.startingPositionRoleId)
				:	null;

			const previousRoleRepresentation =
				previousRole ? `<@&${previousRole.id}> (${previousRole.id})` : 'the premium role (if configured)';
			const newRoleRepresentation = role ? `<@&${role.id}> (${role.id})` : 'the premium role (if configured)';

			await this.container.prisma.premiumGuildRoleConfig.update({
				where: { guildId: interaction.guildId },
				data: { startingPositionRoleId: role?.id ?? null },
			});

			await interaction.reply({
				embeds: [
					createInfoEmbed(
						`Set the starting position role in this server from ${previousRoleRepresentation} to ${newRoleRepresentation}`,
					),
				],
				ephemeral: true,
			});

			return;
		}

		await this.container.prisma.premiumGuildRoleConfig.create({
			data: { guildId: interaction.guildId, startingPositionRoleId: role?.id ?? null },
		});

		const newRoleRepresentation = role ? `<@&${role.id}> (${role.id})` : 'the premium role (if configured)';

		await interaction.reply({
			embeds: [createInfoEmbed(`Set the starting position role in this server to ${newRoleRepresentation}`)],
			ephemeral: true,
		});
	}

	public async listStaffRolesSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		const guildConfigs = await this.container.prisma.premiumGuildRoleConfig.findFirst({
			where: { guildId: interaction.guildId },
		});

		if (!guildConfigs?.staffRoles.length) {
			await interaction.reply({
				embeds: [createInfoEmbed('There are no staff roles configured in this server!')],
				ephemeral: true,
			});

			return;
		}

		const roles = guildConfigs.staffRoles.map((id) => interaction.guild.roles.resolve(id));

		await interaction.reply({
			embeds: [
				createInfoEmbed(
					`**Staff Roles:**\n${roles.map((role) => role?.toString() ?? 'Unknown Role').join('\n')}`,
				),
			],
			ephemeral: true,
		});
	}

	public async addStaffRoleSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		const role = interaction.options.getRole('role', true);

		const guildConfigs = await this.container.prisma.premiumGuildRoleConfig.findFirst({
			where: { guildId: interaction.guildId },
		});

		if (guildConfigs?.staffRoles.includes(role.id)) {
			await interaction.reply({
				embeds: [createInfoEmbed('This role is already a staff role in this server!')],
				ephemeral: true,
			});

			return;
		}

		await this.container.prisma.premiumGuildRoleConfig.upsert({
			where: { guildId: interaction.guildId },
			create: { guildId: interaction.guildId, staffRoles: [role.id] },
			update: { staffRoles: { push: role.id } },
		});

		await interaction.reply({
			embeds: [createInfoEmbed(`Added the role ${role.toString()} to the list of staff roles in this server!`)],
			ephemeral: true,
		});
	}

	public async removeStaffRoleSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		const role = interaction.options.getRole('role', true);

		const guildConfigs = await this.container.prisma.premiumGuildRoleConfig.findFirst({
			where: { guildId: interaction.guildId },
		});

		if (!guildConfigs?.staffRoles.includes(role.id)) {
			await interaction.reply({
				embeds: [createInfoEmbed('This role is not a staff role in this server!')],
				ephemeral: true,
			});

			return;
		}

		await this.container.prisma.premiumGuildRoleConfig.update({
			where: { guildId: interaction.guildId },
			data: { staffRoles: { set: guildConfigs.staffRoles.filter((id) => id !== role.id) } },
		});

		await interaction.reply({
			embeds: [
				createInfoEmbed(`Removed the role ${role.toString()} from the list of staff roles in this server!`),
			],
			ephemeral: true,
		});
	}

	public async addForbiddenNameSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		const name = interaction.options.getString('name', true);

		const existingPattern = await this.container.prisma.forbiddenRoleName.findFirst({
			where: { guildId: interaction.guildId, rawPattern: name },
		});

		if (existingPattern) {
			await interaction.reply({
				embeds: [createInfoEmbed('This pattern is already forbidden in this server!')],
				ephemeral: true,
			});

			return;
		}

		// Patterns baby
		const pattern = remove(name) //
			// Replace commonly confused characters with a pattern matching them
			.replaceAll(/[1il|]/g, '[1il|]')
			// zeros and o's
			.replaceAll(/[0o]/g, '[0o]')
			// Spaces
			.replaceAll(/\s/g, '\\s+');

		await this.container.prisma.forbiddenRoleName.create({
			data: { guildId: interaction.guildId, rawPattern: name, processedPattern: pattern },
		});

		await interaction.reply({
			embeds: [
				createInfoEmbed(`Added the pattern \`${name}\` to the list of forbidden patterns in this server!`),
			],
			ephemeral: true,
		});
	}

	public async removeForbiddenNameSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		const name = interaction.options.getString('name', true);

		const existingPattern = await this.container.prisma.forbiddenRoleName.findFirst({
			where: { guildId: interaction.guildId, rawPattern: name },
		});

		if (!existingPattern) {
			await interaction.reply({
				embeds: [createInfoEmbed('This pattern is not forbidden in this server!')],
				ephemeral: true,
			});

			return;
		}

		await this.container.prisma.forbiddenRoleName.delete({
			where: { guildId_rawPattern: { guildId: interaction.guildId, rawPattern: name } },
		});

		await interaction.reply({
			embeds: [
				createInfoEmbed(`Removed the pattern \`${name}\` from the list of forbidden patterns in this server!`),
			],
			ephemeral: true,
		});
	}

	public async listForbiddenNamesSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		const patterns = await this.container.prisma.forbiddenRoleName.findMany({
			where: { guildId: interaction.guildId },
		});

		if (!patterns.length) {
			await interaction.reply({
				embeds: [createInfoEmbed('There are no forbidden patterns in this server!')],
				ephemeral: true,
			});

			return;
		}

		await interaction.reply({
			embeds: [
				createInfoEmbed(
					`**Forbidden Patterns:**\n- ${patterns.map((pattern) => `\`${escapeMarkdown(pattern.rawPattern)}\``).join('\n- ')}`,
				),
			],
			ephemeral: true,
		});
	}

	public override registerApplicationCommands(registry: Subcommand.Registry) {
		registry.registerChatInputCommand(
			(builder) =>
				builder
					.setName(this.name)
					.setDescription('Handles the configuration of the premium roles in this server')
					.setDMPermission(false)
					.setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
					.addSubcommand((subcommand) =>
						subcommand
							.setName('show-config')
							.setDescription('Shows the current configuration for the premium roles in this server'),
					)
					.addSubcommand((subcommand) =>
						subcommand
							.setName('set-legend-role')
							.setDescription(
								'Sets the legend role for this server (allows premium members to gift it to other members)',
							)
							.addRoleOption((role) =>
								role
									.setName('role')
									.setDescription('The legend role (leave empty to reset/disable the feature)'),
							),
					)
					.addSubcommand((subcommand) =>
						subcommand
							.setName('set-clan-category')
							.setDescription('Sets the clan category for this server')
							.addChannelOption((channel) =>
								channel
									.setName('category')
									.setDescription('The clan category')
									.addChannelTypes(ChannelType.GuildCategory)
									.setRequired(true),
							),
					)
					.addSubcommand((subcommand) =>
						subcommand
							.setName('set-clan-invites-channel')
							.setDescription('Sets the channel in which clan invites will be sent')
							.addChannelOption((channel) =>
								channel
									.setName('channel')
									.setDescription('The channel in which to send the clan invites')
									.addChannelTypes(ChannelType.GuildText)
									.setRequired(true),
							),
					)
					.addSubcommandGroup((role) =>
						role
							.setName('role-abilities')
							.setDescription('Manage which role gives which ability to the members who have it')
							.addSubcommand((subcommand) =>
								subcommand.setName('list').setDescription('Lists the current role abilities'),
							)
							.addSubcommand((subcommand) =>
								subcommand
									.setName('add')
									.setDescription('Adds an ability to a role')
									.addRoleOption((role) =>
										role
											.setName('role')
											.setDescription('The role to add an ability to')
											.setRequired(true),
									)
									.addStringOption((option) =>
										option
											.setName('ability')
											.setDescription('The ability to add')
											.addChoices(
												{ name: 'Create a clan', value: 'canCreateClan' },
												{ name: 'Create a custom role', value: 'canCreateCustomRole' },
												{ name: 'Gift Legend', value: 'canGiftLegend' },
												{
													name: 'Use abilities on multiple servers',
													value: 'areAbilitiesMultiGuild',
												},
											)
											.setRequired(true),
									),
							)
							.addSubcommand((subcommand) =>
								subcommand
									.setName('remove')
									.setDescription('Removes an ability from a role')
									.addRoleOption((role) =>
										role
											.setName('role')
											.setDescription('The role to remove an ability from')
											.setRequired(true),
									)
									.addStringOption((option) =>
										option
											.setName('ability')
											.setDescription('The ability to remove')
											.addChoices(
												{ name: 'Create a clan', value: 'canCreateClan' },
												{ name: 'Create a custom role', value: 'canCreateCustomRole' },
												{ name: 'Gift Legend', value: 'canGiftLegend' },
												{
													name: 'Use abilities on multiple servers',
													value: 'areAbilitiesMultiGuild',
												},
											)
											.setRequired(true),
									),
							),
					)
					.addSubcommand((subcommand) =>
						subcommand
							.setName('set-position-role')
							.setDescription(
								'Sets the role that should be used as a starting position for custom premium roles for this server',
							)
							.addRoleOption((role) =>
								role
									.setName('role')
									.setDescription('The position role (leave empty to reset/use the premium role)'),
							),
					)
					.addSubcommandGroup((role) =>
						role
							.setName('staff-roles')
							.setDescription(
								'Manage the staff roles in this server to prevent custom roles from having similar colors',
							)
							.addSubcommand((subcommand) =>
								subcommand
									.setName('list')
									.setDescription('Lists the current staff roles in this server'),
							)
							.addSubcommand((subcommand) =>
								subcommand
									.setName('add')
									.setDescription('Adds a staff role to the list of staff roles')
									.addRoleOption((role) =>
										role.setName('role').setDescription('The staff role to add').setRequired(true),
									),
							)
							.addSubcommand((subcommand) =>
								subcommand
									.setName('remove')
									.setDescription('Removes a staff role from the list of staff roles')
									.addRoleOption((role) =>
										role
											.setName('role')
											.setDescription('The staff role to remove')
											.setRequired(true),
									),
							),
					)
					.addSubcommandGroup((role) =>
						role
							.setName('forbidden-names')
							.setDescription('Manage the forbidden names for custom roles in this server')
							.addSubcommand((subcommand) =>
								subcommand
									.setName('add')
									.setDescription('Adds a forbidden name to the list of forbidden names')
									.addStringOption((name) =>
										name
											.setName('name')
											.setDescription('The forbidden name to add (supports regular expressions)')
											.setRequired(true),
									),
							)
							.addSubcommand((subcommand) =>
								subcommand
									.setName('remove')
									.setDescription('Removes a forbidden name from the list of forbidden names')
									.addStringOption((name) =>
										name
											.setName('name')
											.setDescription('The forbidden name to remove')
											.setRequired(true),
									),
							)
							.addSubcommand((subcommand) =>
								subcommand
									.setName('list')
									.setDescription('Shows the current forbidden names in this server'),
							),
					)
					.addSubcommandGroup((dir) =>
						dir
							.setName('directory')
							.setDescription('Manage the clan directory in this server')
							.addSubcommand((subcommand) =>
								subcommand
									.setName('set-channel')
									.setDescription('Sets the channel for the clan directory')
									.addChannelOption((channel) =>
										channel
											.setName('channel')
											.setDescription('The text channel for the directory')
											.addChannelTypes(ChannelType.GuildText)
											.setRequired(true),
									),
							),
					),
		);
	}

	public async setDirectoryChannelSubcommand(interaction: Subcommand.ChatInputCommandInteraction<'cached'>) {
		const channel = interaction.options.getChannel('channel', true);

		// 1. Validate Channel Type
		if (!channel || channel.type !== ChannelType.GuildText) {
			await interaction.reply({
				embeds: [createErrorEmbed('Please provide a valid text channel.')],
				ephemeral: true,
			});
			return;
		}

		// 2. Check Bot Permissions
		const me = await interaction.guild.members.fetch(this.container.client.user!.id);
		const permissions = channel.permissionsFor(me);
		if (!permissions.has(PermissionFlagsBits.SendMessages) || !permissions.has(PermissionFlagsBits.ReadMessageHistory)) {
			await interaction.reply({
				embeds: [createErrorEmbed(`I need permissions to Send Messages and Read Message History in <#${channel.id}>.`)],
				ephemeral: true,
			});
			return;
		}

		// 3. Always Send a New Initial Message
		let directoryMessage: Message;
		try {
			directoryMessage = await (channel as TextChannel).send({ embeds: [createInfoEmbed('Clan Directory is initializing... Please wait for the next update.')] });
			this.container.logger.info(`[CLAN DIRECTORY CONFIG] Sent initial message ${directoryMessage.id} to channel ${channel.id} for guild ${interaction.guildId}`);
		} catch (error) {
			this.container.logger.error(`[CLAN DIRECTORY CONFIG] Failed to send initial message to channel ${channel.id} for guild ${interaction.guildId}`, error);
			await interaction.reply({
				embeds: [createErrorEmbed('Failed to send the initial directory message. Please check my permissions in that channel.')],
				ephemeral: true,
			});
			return;
		}

		// 4. Update or Create Config in Database (Upsert)
		const dataToSave = {
			clanDirectoryChannelId: channel.id,
			clanDirectoryMessageId: directoryMessage.id, // Save the new message ID
		};

		await this.container.prisma.premiumGuildRoleConfig.upsert({
			where: { guildId: interaction.guildId },
			update: dataToSave,
			create: { guildId: interaction.guildId, ...dataToSave },
		});
		this.container.logger.info(`[CLAN DIRECTORY CONFIG] Upserted config for guild ${interaction.guildId} with channel ${channel.id} and message ${directoryMessage.id}`);


		// 5. Respond to User
		await interaction.reply({
			embeds: [createInfoEmbed(`✅ Set the clan directory channel to <#${channel.id}>. The directory message ID is \`${directoryMessage.id}\`. It will be updated automatically.`)],
			ephemeral: true,
		});

		// 6. Trigger Immediate Update (Optional but Recommended)
		const task = this.container.client.stores.get('tasks').get('UpdateClanDirectory');
		if (task) {
			this.container.logger.info(`[CLAN DIRECTORY CONFIG] Triggering immediate update task for guild ${interaction.guildId}`);
			try {
				// Don't await this directly in the interaction reply flow if it might take time
				void task.run();
			} catch (err) {
				this.container.logger.error('[CLAN DIRECTORY CONFIG] Error triggering immediate task update:', err);
			}
		}
	}
}