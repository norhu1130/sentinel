-- CreateEnum
CREATE TYPE "ClanEventType" AS ENUM ('Created', 'Deleted', 'Orphaned', 'OrphanCancelled', 'Restored', 'MemberJoined', 'MemberLeft', 'OwnershipTransferred', 'Renamed', 'IconChanged', 'DescriptionChanged', 'VisibilityChanged', 'PremiumRoleDeleted', 'GiftedRoleRevoked');

-- CreateTable
CREATE TABLE "clan_history_events" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "customRoleId" TEXT NOT NULL,
    "clanName" TEXT,
    "ownerUserId" TEXT,
    "eventType" "ClanEventType" NOT NULL,
    "actorUserId" TEXT,
    "targetUserId" TEXT,
    "reason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clan_history_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "clan_history_events_guildId_customRoleId_createdAt_idx" ON "clan_history_events"("guildId", "customRoleId", "createdAt");

-- CreateIndex
CREATE INDEX "clan_history_events_guildId_ownerUserId_idx" ON "clan_history_events"("guildId", "ownerUserId");
