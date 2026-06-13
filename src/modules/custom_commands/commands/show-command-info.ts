import { Command } from '@sapphire/framework';
import { ApplicationCommandType, InteractionContextType, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { createInfoEmbed } from '../../../lib/utils/createEmbed.js';
import { CUSTOM_COMMAND_PREFIX } from '../customCommandUtils.js';

/**
 * Message context menu command ("Apps → Show Command Info") for moderators. Run it on a bot
 * custom-command response to see which command it was, who triggered it, and who created it —
 * useful for auditing abuse after the fact.
 */
export class ShowCommandInfoCommand extends Command {
	public override registerApplicationCommands(registry: Command.Registry) {
		registry.registerContextMenuCommand((builder) =>
			builder
				.setName('Show Command Info')
				.setType(ApplicationCommandType.Message)
				.setContexts(InteractionContextType.Guild)
				.setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
		);
	}

	public override async contextMenuRun(interaction: Command.ContextMenuCommandInteraction) {
		if (!interaction.isMessageContextMenuCommand()) {
			return;
		}

		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		const usage = await this.container.prisma.customCommandUsage.findFirst({
			where: { messageId: interaction.targetId },
			orderBy: { usedAt: 'desc' },
		});

		if (!usage) {
			await interaction.editReply({
				embeds: [createInfoEmbed("This message isn't a recorded custom command response.")],
			});
			return;
		}

		const command = await this.container.prisma.customCommand.findUnique({
			where: {
				guildId_clanCustomRoleId_name: {
					guildId: usage.guildId,
					clanCustomRoleId: usage.clanCustomRoleId,
					name: usage.name,
				},
			},
		});

		const clanName = interaction.guild?.roles.cache.get(usage.clanCustomRoleId)?.name ?? usage.clanCustomRoleId;
		const usedAtUnix = Math.floor(usage.usedAt.getTime() / 1_000);
		const creator = command ? `<@${command.createdBy}>` : 'unknown (command has since been deleted)';

		await interaction.editReply({
			embeds: [
				createInfoEmbed(
					[
						`**Command:** \`${CUSTOM_COMMAND_PREFIX}${usage.name}\``,
						`**Clan:** ${clanName}`,
						`**Triggered by:** <@${usage.usedBy}> (${usage.usedBy})`,
						`**Used:** <t:${usedAtUnix}:F> (<t:${usedAtUnix}:R>)`,
						`**Created by:** ${creator}`,
					].join('\n'),
				),
			],
		});
	}
}
