/*
  Warnings:

  - You are about to drop the column `clanDirectoryMessageId` on the `premium_guild_role_configs` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "premium_guild_role_configs" DROP COLUMN "clanDirectoryMessageId",
ADD COLUMN     "clanDirectoryMessageIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
