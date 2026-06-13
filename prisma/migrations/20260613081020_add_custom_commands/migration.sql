-- AlterTable
ALTER TABLE "premium_guild_role_configs" ADD COLUMN     "customCommandInputMode" TEXT NOT NULL DEFAULT 'upload';

-- AlterTable
ALTER TABLE "role_abilities" ADD COLUMN     "canCreateCustomCommand" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "custom_commands" (
    "guildId" TEXT NOT NULL,
    "clanCustomRoleId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "text" TEXT,
    "mediaData" BYTEA,
    "mediaUrl" TEXT,
    "mediaType" TEXT,
    "mediaName" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_commands_pkey" PRIMARY KEY ("guildId","clanCustomRoleId","name")
);

-- CreateTable
CREATE TABLE "custom_command_usage" (
    "id" SERIAL NOT NULL,
    "guildId" TEXT NOT NULL,
    "clanCustomRoleId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "usedBy" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_command_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "custom_commands_guildId_name_idx" ON "custom_commands"("guildId", "name");

-- CreateIndex
CREATE INDEX "custom_command_usage_messageId_idx" ON "custom_command_usage"("messageId");

-- CreateIndex
CREATE INDEX "custom_command_usage_guildId_name_idx" ON "custom_command_usage"("guildId", "name");

-- CreateIndex
CREATE INDEX "custom_command_usage_usedAt_idx" ON "custom_command_usage"("usedAt");

-- AddForeignKey
ALTER TABLE "custom_commands" ADD CONSTRAINT "custom_commands_guildId_clanCustomRoleId_fkey" FOREIGN KEY ("guildId", "clanCustomRoleId") REFERENCES "clan"("guildId", "customRoleId") ON DELETE CASCADE ON UPDATE CASCADE;
