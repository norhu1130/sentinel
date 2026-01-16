# Flokie Utils Bot - Developer Guide

## Project Overview

**Flokie Utils Bot** is a production Discord utility bot built with TypeScript, discord.js v14, and the Sapphire Framework. It provides server moderation, community engagement, and premium features including a clan system. The bot uses PostgreSQL with Prisma ORM for data persistence.

**Key Features:**

-   Vote kick system for voice channel moderation
-   Auto-pinned messages with scheduled updates
-   Poll creation and management
-   Media-only channel enforcement
-   Role and ban synchronization across guilds
-   Premium clan system with custom roles and channels
-   Role-based notification system
-   Invite pruning and moderation tools

## Technology Stack

-   **Runtime:** Node.js v16+ (LTS recommended)
-   **Language:** TypeScript (ES2022 target, strict mode)
-   **Framework:** Sapphire Framework v5 (@sapphire/framework)
-   **Discord Library:** discord.js v14.22.1
-   **Database:** PostgreSQL with Prisma ORM v5.8.1
-   **Code Quality:** ESLint + Prettier (neon config)

## Project Structure

```
src/
├── main.ts                     # Entry point - initializes bot
├── lib/
│   ├── UtilsBot.ts            # Extended SapphireClient with Prisma integration
│   ├── abilities/             # Permission and ability system for role/clan management
│   ├── schedule/              # Task scheduling system (ScheduleManager, ScheduleEntity)
│   ├── utils/                 # Shared utilities, caches, hooks, and helpers
│   └── extensions/            # Custom error classes (UserError)
├── commands/                  # Core slash commands (votekick, autopin, poll, etc.)
├── modules/                   # Feature modules (extensible architecture)
│   ├── custom_roles/         # Premium role system with clan features
│   ├── visible_rank_roles/   # Visible rank role synchronization
│   └── notifications/        # Role-based notification system
├── listeners/                 # Discord event listeners (ready, errors, feature listeners)
├── tasks/                     # Scheduled tasks (auto-pins, polls, vote kicks, clan cleanup)
└── interaction-handlers/      # Button and select menu handlers
```

### Key Directories Explained

-   **`commands/`**: Slash commands in the root directory are core bot features
-   **`modules/`**: Self-contained feature modules with their own commands/listeners/handlers
-   **`listeners/`**: Event-based logic (message creates, deletes, reactions, etc.)
-   **`tasks/`**: Scheduled jobs managed by ScheduleManager
-   **`interaction-handlers/`**: Handle Discord component interactions (buttons, select menus)
-   **`lib/abilities/`**: Permission checking system for clans and role management

## Architecture Patterns

### Sapphire Framework

The bot uses the Sapphire Framework, which provides:

-   **Piece-based architecture**: Commands, listeners, and handlers are auto-loaded
-   **Plugin system**: Subcommands plugin for complex command structures
-   **Preconditions**: Permission checks before command execution
-   **Utilities**: Decorators, paginated messages, and Discord helpers

### Command Structure

Commands use the Sapphire `Command` class with slash command support:

```typescript
export class MyCommand extends Command {
	public override registerApplicationCommands(registry: Command.Registry) {
		registry.registerChatInputCommand((builder) => builder.setName('mycommand').setDescription('Does something'));
	}

	public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
		// Command logic here
	}
}
```

For complex commands with subcommands, use `@sapphire/plugin-subcommands`:

```typescript
export class MySubcommandCommand extends Subcommand {
	public override registerApplicationCommands(registry: Subcommand.Registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName('mycommand')
				.setDescription('Command with subcommands')
				.addSubcommand((sub) => sub.setName('create').setDescription('Create something')),
		);
	}

	@RegisterSubcommand('create', (builder) => builder.setDescription('Create'))
	public async create(interaction: Subcommand.ChatInputCommandInteraction) {
		// Subcommand logic
	}
}
```

### Module System

Modules are self-contained features in `src/modules/`. Each module can have:

-   `commands/`: Module-specific slash commands
-   `listeners/`: Module-specific event listeners
-   `interaction-handlers/`: Module-specific button/menu handlers
-   Shared utilities or logic within the module directory

Modules are automatically loaded by Sapphire's piece system.

### Database Access

Database access is via Prisma ORM. The client is attached to the bot instance:

```typescript
const { prisma } = this.container.client;
await prisma.user.findUnique({ where: { id: userId } });
```

Prisma schema is in `prisma/schema.prisma`. Migrations are managed via Prisma CLI.

### Task Scheduling

The bot has a custom `ScheduleManager` for scheduling tasks:

1. Tasks extend the `Task` abstract class
2. Tasks are stored in the database (`Schedule` model)
3. The manager polls and executes tasks at their scheduled time
4. Tasks can be recurring or one-time

Example:

```typescript
export class MyTask extends Task {
	public async run(): Promise<void> {
		// Task logic
	}
}

// Schedule a task
await ScheduleManager.schedule(MyTask, guildId, date, data);
```

## Database Schema

Key Prisma models:

-   **`Schedule`**: Scheduled task entries (task name, time, data)
-   **`VoteKick`**: Vote kick records with voter tracking
-   **`User`**: User kick counts and timeout tracking
-   **`AutoPin`**: Auto-pinned messages with scheduling info
-   **`Poll`**, **`PollAnswer`**: Poll data and user responses
-   **`MessageOnlyChannel`**: Channels requiring media attachments
-   **`RoleSync`**: Cross-guild role synchronization
-   **`SharedGuildBan`**: Synchronized bans across guilds
-   **`PremiumMember`**, **`PremiumGuildRoleConfig`**: Premium features
-   **`Clan`**, **`ClanMember`**: Clan system
-   **`ClanEmojiCache`**: Caches clan role icon hashes to detect changes and avoid unnecessary re-uploads
-   **`RoleAbilities`**: Permission management for roles
-   **`Notification`**, **`UserNotification`**: Notification system

### Running Migrations

```bash
# Create a new migration
npx prisma migrate dev --name migration_name

# Apply migrations in production
npx prisma migrate deploy

# Generate Prisma client after schema changes
npx prisma generate
```

## Environment Configuration

Required environment variables (`.env` file):

```env
# Discord
DISCORD_TOKEN=your_bot_token
LFG_GUILD_ID=primary_guild_id
LFG_VOTEKICK_CHANNEL=votekick_channel_id
BLOCKED_FROM_VOICE_CHANNEL_ROLE_ID=blocked_role_id
MODLOG_CHANNEL_ID=modlog_channel_id
GUILD_IDS_TO_SYNC_BANS_IN=comma,separated,guild,ids

# PostgreSQL Database
DATABASE_USERNAME=postgres_user
DATABASE_PASSWORD=postgres_password
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_NAME=flokie_utils
DATABASE_URL=postgresql://${DATABASE_USERNAME}:${DATABASE_PASSWORD}@${DATABASE_HOST}:${DATABASE_PORT}/${DATABASE_NAME}
```

## Development Workflow

### Setup

```bash
# Install dependencies
npm install

# Setup database
npx prisma migrate deploy
npx prisma generate

# Build
npm run build

# Start bot
npm start
```

### Scripts

-   `npm start`: Clean build and run the bot
-   `npm run build`: Compile TypeScript to `dist/`
-   `npm run cleanbuild`: Remove `dist/` and rebuild
-   `npm run watch`: Watch mode for development
-   `npm run lint`: Check code style with ESLint
-   `npm run format`: Auto-format code with Prettier and ESLint

### Testing & Deployment

**Testing Approach**: Manual testing in Discord

-   Test new commands and features in a test server or channel
-   Verify database changes don't break existing functionality
-   Check error handling and edge cases

**Deployment**:

1. Build the project: `npm run cleanbuild`
2. Run migrations: `npx prisma migrate deploy`
3. Restart the bot (PM2 or manual restart)

## Common Development Tasks

### Adding a New Slash Command

1. Create a new file in `src/commands/` (or `src/modules/{module}/commands/`)
2. Extend `Command` or `Subcommand` from Sapphire
3. Implement `registerApplicationCommands()` and command handler
4. The command will be auto-loaded on restart

### Adding a New Event Listener

1. Create a file in `src/listeners/` (or module listener directory)
2. Extend `Listener` from Sapphire
3. Specify the event to listen to
4. Implement the `run()` method

### Adding a Scheduled Task

1. Create a task class extending `Task` in `src/tasks/`
2. Implement the `run()` method
3. Schedule the task using `ScheduleManager.schedule(TaskClass, guildId, date, data)`
4. Tasks are automatically executed at their scheduled time

### Adding Database Models

1. Edit `prisma/schema.prisma`
2. Run `npx prisma migrate dev --name your_migration_name`
3. Run `npx prisma generate` to update the Prisma client
4. Restart the bot with the new schema

## Special Systems & Features

### Clan System (`modules/custom_roles`)

The clan system allows premium members to create clans with:

-   Custom clan roles (with color validation to prevent conflicts)
-   Clan-specific channels
-   Member management (join requests, kicks, ownership transfer)
-   Automatic directory updates
-   Orphan clan cleanup

**Key Components:**

-   **Commands**: `/clan`, `/custom-role`, `/gift`, `/config-premium`
-   **Abilities**: `ClanManager` handles permission checks
-   **Tasks**: `UpdateClanDirectory`, `deleteOrphanClan`
-   **Database**: `Clan`, `ClanMember`, `PremiumMember`, `RoleAbilities`, `ClanEmojiCache`

**Color Validation**: Uses `looks-same` library to prevent clan roles from having similar colors to staff roles.

**Icon Caching**: Clan role icons are cached in `ClanEmojiCache` to track icon hash changes. Application emojis are only re-uploaded when the icon actually changes, reducing unnecessary API calls and improving performance.

### Vote Kick System

Democratic voice channel moderation:

-   Users in a voice channel can vote to kick someone
-   Configurable vote thresholds
-   Cooldowns and tracking in database
-   Automatic cleanup of expired votes

### Auto-Pin System

Recurring messages that stay pinned to the bottom of a channel:

-   Messages automatically reposted at intervals
-   Can be configured per channel
-   Scheduled via `ScheduleManager`

### Abilities/Permission System (`lib/abilities`)

Custom permission system for managing role-based abilities:

-   Guild-specific and multi-guild abilities
-   Role color validation
-   Forbidden role name checking
-   Used primarily for clan and custom role management

## Performance Considerations

The bot has custom Discord.js cache settings to reduce memory usage:

-   **Message cache**: Limited to 50 messages
-   **User cache**: Limited to 100 users (bot user never removed)
-   **Sweepers**: Configured for automatic cleanup of old cache entries

These settings are in `src/lib/UtilsBot.ts`.

## Code Style & Standards

-   **TypeScript**: Strict mode enabled, ES2022 target
-   **ESLint**: Uses `@neon-utils/prettier-config` and `@neon-utils/eslint-config-ts`
-   **Formatting**: Prettier with 2-space tabs, single quotes, trailing commas
-   **Imports**: Organized and explicit, no wildcard imports
-   **Error Handling**: Use `UserError` class for user-facing errors

### Error Handling Pattern

```typescript
import { UserError } from '../lib/extensions/UserError.js';

// For expected user errors (shows friendly message)
throw new UserError('You do not have permission to do this');

// For unexpected errors (shows generic error + logs)
throw new Error('Unexpected database error');
```

## Important Notes

-   **Production bot**: Changes affect live users, test thoroughly
-   **No major gotchas**: Codebase is straightforward and well-structured
-   **Prisma queries**: Be mindful of N+1 queries and use `include` strategically
-   **Discord rate limits**: Use built-in discord.js rate limit handling
-   **Scheduled tasks**: Tasks run in-process, long-running tasks should be async
-   **Caching**: Be aware of Discord cache limitations, refetch data when needed
-   **Git commits**: Do NOT add Co-Authored-By lines to commits
-   **"Take note"**: When told to "take note", add it to this file (CLAUDE.md), don't just acknowledge

## Resources

-   [Sapphire Framework Docs](https://www.sapphirejs.dev/)
-   [discord.js Guide](https://discordjs.guide/)
-   [Prisma Documentation](https://www.prisma.io/docs/)
-   [Discord API Types](https://discord-api-types.dev/)

## Local Documentation

Additional reference docs are in `.claude/*.local.md` (gitignored). Currently available:

-   `components-v2.local.md` - Discord Components V2 API reference and patterns

## Getting Help

For questions or issues:

-   Check the Sapphire Framework documentation
-   Review similar existing commands/listeners for patterns
-   The codebase is well-organized - look at similar features for guidance
