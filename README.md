# Flokie Utils Bot

A simple slash command based bot that hosts some utilities, mainly:

- Keeping a bot message at the end of the channel on an interval
- Syncing bans across guilds
- Allowing only messages that have attachments in certain channels

## How to setup

# ⚠️ Make sure the bot application you created has the `Server Members` and `Message Content` intents enabled!

1. Make sure you have `node.js` version 16 or higher installed. (latest LTS version is recommended)
1. Clone this repository
1. Run `npm ci` to install all dependencies
1. Copy the `.env.example` file to `.env` and fill in everything above the comment. You can see examples of the values pre-filled in the file.
1. Run `npx prisma db push` to generate missing tables and push any schema changes if applicable.
1. Once you're done, run `npm run cleanbuild` to build the source code.
1. Start the bot by running `node dist/main.js` (or pm2 if you want)

## How to update

1. Pull in the changes
1. Run `npm ci` to install/update all dependencies for safety
1. Run `npx prisma db push` to push any schema changes if applicable.
1. Run `npm run cleanbuild` to build the source code
1. Double check that `.env.sample` has the same values as `.env`, and update `.env` if you see any differences.
1. Restart the bot.

### If you have any questions, feel free to ask Vladdy#0002
