-- AlterTable
ALTER TABLE "clan" ADD COLUMN     "description" TEXT;

-- AlterTable
ALTER TABLE "premium_guild_role_configs" ADD COLUMN     "clanDirectoryChannelId" TEXT,
ADD COLUMN     "clanDirectoryMessageId" TEXT;
