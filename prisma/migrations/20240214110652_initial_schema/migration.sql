-- CreateEnum
CREATE TYPE "RoleSyncType" AS ENUM ('AcrossGuilds', 'VisibleRank');

-- CreateTable
CREATE TABLE "schedules" (
    "id" SERIAL NOT NULL,
    "task_id" TEXT NOT NULL,
    "time" TIMESTAMP(3) NOT NULL,
    "recurring" TEXT,
    "data" TEXT,

    CONSTRAINT "schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_only_channels" (
    "channel_id" TEXT NOT NULL,
    "guild_id" TEXT NOT NULL,

    CONSTRAINT "message_only_channels_pkey" PRIMARY KEY ("channel_id")
);

-- CreateTable
CREATE TABLE "shared_guild_bans" (
    "user_id" TEXT NOT NULL,
    "guild_id" TEXT NOT NULL,
    "reason" TEXT,

    CONSTRAINT "shared_guild_bans_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "auto_pins" (
    "id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "button_link" TEXT,
    "button_label" TEXT,
    "channel_id" TEXT NOT NULL,
    "guild_id" TEXT NOT NULL,
    "check_every_seconds" BIGINT NOT NULL,
    "last_check" TIMESTAMP(3) NOT NULL,
    "last_message_id" TEXT,

    CONSTRAINT "auto_pins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vote_kick" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_to_kick" TEXT NOT NULL,
    "started_by" TEXT NOT NULL,
    "voters_agreeing_with_kick" TEXT[],
    "voters_disagreeing_with_kick" TEXT[],
    "message_url" TEXT NOT NULL,
    "voice_channel_id" TEXT NOT NULL,
    "reason" TEXT,

    CONSTRAINT "vote_kick_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "kicks" INTEGER NOT NULL,
    "remove_role_at" TIMESTAMP(3),
    "reset_kicks_at" TIMESTAMP(3),

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guild_member" (
    "userId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "syncVisibleRanks" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "guild_member_pkey" PRIMARY KEY ("userId","guildId")
);

-- CreateTable
CREATE TABLE "polls" (
    "id" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "options" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "ended" BOOLEAN NOT NULL DEFAULT false,
    "guild_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,

    CONSTRAINT "polls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "poll_answers" (
    "poll_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "option_index" INTEGER NOT NULL,

    CONSTRAINT "poll_answers_pkey" PRIMARY KEY ("poll_id","user_id")
);

-- CreateTable
CREATE TABLE "role_syncs" (
    "id" TEXT NOT NULL,
    "origin_guild_id" TEXT NOT NULL,
    "origin_role_id" TEXT NOT NULL,
    "destination_guild_id" TEXT NOT NULL,
    "destination_role_id" TEXT NOT NULL,
    "type" "RoleSyncType" NOT NULL DEFAULT 'AcrossGuilds',

    CONSTRAINT "role_syncs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invite_prunes" (
    "guild_id" TEXT NOT NULL,

    CONSTRAINT "invite_prunes_pkey" PRIMARY KEY ("guild_id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_notifications" (
    "userId" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "notifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_notifications_pkey" PRIMARY KEY ("userId","notificationId")
);

-- CreateTable
CREATE TABLE "titan_guild_role_configs" (
    "guildId" TEXT NOT NULL,
    "originalTitanRoleId" TEXT,
    "giftableRoleId" TEXT,
    "staffRoles" TEXT[],

    CONSTRAINT "titan_guild_role_configs_pkey" PRIMARY KEY ("guildId")
);

-- CreateTable
CREATE TABLE "titan_members" (
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "customRoleId" TEXT,
    "giftedRoleToUserId" TEXT,

    CONSTRAINT "titan_members_pkey" PRIMARY KEY ("guildId","userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_id_key" ON "user"("id");

-- AddForeignKey
ALTER TABLE "poll_answers" ADD CONSTRAINT "poll_answers_poll_id_fkey" FOREIGN KEY ("poll_id") REFERENCES "polls"("id") ON DELETE CASCADE ON UPDATE CASCADE;
