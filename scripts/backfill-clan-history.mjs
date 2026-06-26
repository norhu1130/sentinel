#!/usr/bin/env node
/**
 * Best-effort backfill of clan history from the bot's pm2 logs.
 *
 * Parses historical log lines and seeds `clan_history_events` rows for clan creations, orphanings
 * and deletions that happened before the audit-history feature existed. Every seeded row is tagged
 * `metadata.backfilled = true` and `metadata.source = 'pm2-logs'`, and the run is idempotent
 * (existing events with the same customRoleId + eventType + timestamp are skipped).
 *
 * DEFAULTS TO DRY-RUN. It prints what it would insert and writes nothing until you pass --apply.
 *
 * Usage (run from the project root on the box, after the migration is deployed):
 *   node scripts/backfill-clan-history.mjs                 # dry-run, default log paths
 *   node scripts/backfill-clan-history.mjs --apply         # actually insert
 *   node scripts/backfill-clan-history.mjs --logs "/home/lily/.pm2/logs/sentinel.log,/path/two.log.gz"
 *   node scripts/backfill-clan-history.mjs --guild 679875946597056683 --apply
 *
 * Timestamps in the logs are parsed as UTC; if your logs are in another timezone the seeded times
 * may be offset by that amount. This is acceptable for a best-effort historical backfill.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { PrismaClient } from '@prisma/client';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const guildFilter = readFlag('--guild');
const logsFlag = readFlag('--logs');
const envPath = readFlag('--env') ?? '.env';

function readFlag(name) {
	const index = args.indexOf(name);
	return index !== -1 && args[index + 1] ? args[index + 1] : null;
}

function readEnvValue(content, key) {
	const match = content.match(new RegExp(`^\\s*${key}\\s*=(.*)$`, 'm'));
	if (!match) return null;
	const value = match[1].trim();
	// Strip surrounding quotes and any trailing inline comment outside the quotes.
	const quoted = value.match(/^"([^"]*)"/) ?? value.match(/^'([^']*)'/);
	if (quoted) return quoted[1];
	return value.replace(/\s+#.*$/, '').trim();
}

function buildDatabaseUrl() {
	if (process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('${')) {
		return process.env.DATABASE_URL;
	}

	const env = readFileSync(envPath, 'utf8');
	const user = encodeURIComponent(readEnvValue(env, 'DATABASE_USERNAME') ?? 'postgres');
	const pass = encodeURIComponent(readEnvValue(env, 'DATABASE_PASSWORD') ?? '');
	const host = readEnvValue(env, 'DATABASE_HOST') ?? 'localhost';
	const port = readEnvValue(env, 'DATABASE_PORT') ?? '5432';
	const name = readEnvValue(env, 'DATABASE_NAME') ?? 'postgres';
	return `postgresql://${user}:${pass}@${host}:${port}/${name}`;
}

function resolveLogFiles() {
	if (logsFlag) {
		return logsFlag
			.split(',')
			.map((path) => path.trim())
			.filter(Boolean);
	}

	const dir = join(homedir(), '.pm2', 'logs');
	const files = [join(dir, 'sentinel.log'), join(dir, 'sentinel.log.save')];
	try {
		for (const entry of readdirSync(dir)) {
			if (entry.startsWith('sentinel__') && entry.endsWith('.log.gz')) {
				files.push(join(dir, entry));
			}
		}
	} catch {
		// Directory may not exist in non-prod environments; rely on --logs instead.
	}

	return files;
}

// Matches an ANSI colour escape sequence (ESC [ ... m). Built from the escape char code to avoid
// embedding a literal control byte in source.
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function readLogFile(path) {
	try {
		const raw = readFileSync(path);
		const text = path.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
		return text.replace(ANSI_RE, '');
	} catch {
		return '';
	}
}

const TS_RE = /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/;
const ROLE_RE = /@&(\d+)/;
const GUILD_RE = /\*(\d+)\]/;
const OWNER_RE = /\[@(\d+)@&/;

function parseLine(line) {
	const ts = line.match(TS_RE);
	if (!ts) return null;
	const createdAt = new Date(`${ts[1]}T${ts[2]}Z`);

	// Deleted — the scheduled task logs the role + guild as JSON; most reliable signal.
	const deletedData = line.match(/deleteOrphanClan with data:\s*(\{.*\})/);
	if (deletedData) {
		try {
			const data = JSON.parse(deletedData[1]);
			if (data.customRoleId && data.guildId) {
				return {
					guildId: data.guildId,
					customRoleId: data.customRoleId,
					eventType: 'Deleted',
					createdAt,
					reason: 'Orphan grace period expired (backfilled)',
				};
			}
		} catch {
			// ignore malformed JSON
		}
	}

	const role = line.match(ROLE_RE)?.[1];
	const guild = line.match(GUILD_RE)?.[1];
	const owner = line.match(OWNER_RE)?.[1] ?? null;
	if (!role || !guild) return null;

	if (/Creating clan channel/.test(line)) {
		const named = line.match(/Creating clan channel (.+?) for (\d+)/);
		return {
			guildId: guild,
			customRoleId: role,
			eventType: 'Created',
			ownerUserId: named?.[2] ?? owner,
			clanName: named?.[1] ?? null,
			createdAt,
			reason: 'Clan created (backfilled)',
		};
	}

	if (/Clan marked as orphan successfully|Set deletion task ID/.test(line)) {
		return {
			guildId: guild,
			customRoleId: role,
			eventType: 'Orphaned',
			ownerUserId: owner,
			createdAt,
			reason: 'Owner left the server (backfilled)',
		};
	}

	if (/Deleted deletion task to make clan not orphan/.test(line)) {
		return {
			guildId: guild,
			customRoleId: role,
			eventType: 'OrphanCancelled',
			ownerUserId: owner,
			createdAt,
			reason: 'Owner returned (backfilled)',
		};
	}

	return null;
}

function dedupeKey(event) {
	return `${event.customRoleId}|${event.eventType}|${new Date(event.createdAt).toISOString()}`;
}

async function main() {
	const prisma = new PrismaClient({ datasources: { db: { url: buildDatabaseUrl() } } });

	try {
		const files = resolveLogFiles();
		console.log(`Reading ${files.length} log file(s)...`);

		const parsed = [];
		const seenInRun = new Set();
		for (const file of files) {
			const text = readLogFile(file);
			if (!text) continue;
			for (const line of text.split('\n')) {
				const event = parseLine(line);
				if (!event) continue;
				if (guildFilter && event.guildId !== guildFilter) continue;
				const key = dedupeKey(event);
				if (seenInRun.has(key)) continue;
				seenInRun.add(key);
				parsed.push(event);
			}
		}

		// Skip events already present in the DB (idempotency across re-runs).
		const existing = await prisma.clanHistoryEvent.findMany({
			select: { customRoleId: true, eventType: true, createdAt: true },
		});
		const existingKeys = new Set(existing.map((event) => dedupeKey(event)));
		const toInsert = parsed.filter((event) => !existingKeys.has(dedupeKey(event)));

		const counts = toInsert.reduce((acc, event) => {
			acc[event.eventType] = (acc[event.eventType] ?? 0) + 1;
			return acc;
		}, {});

		console.log(`Parsed ${parsed.length} event(s); ${toInsert.length} new after dedupe.`);
		console.log('By type:', counts);

		if (!APPLY) {
			console.log('\nDRY RUN — nothing written. Re-run with --apply to insert these events.');
			for (const event of toInsert.slice(0, 20)) {
				console.log(
					`  ${new Date(event.createdAt).toISOString()} ${event.eventType} role=${event.customRoleId}`,
				);
			}
			if (toInsert.length > 20) console.log(`  ...and ${toInsert.length - 20} more`);
			return;
		}

		let inserted = 0;
		for (const event of toInsert) {
			await prisma.clanHistoryEvent.create({
				data: {
					guildId: event.guildId,
					customRoleId: event.customRoleId,
					eventType: event.eventType,
					clanName: event.clanName ?? null,
					ownerUserId: event.ownerUserId ?? null,
					reason: event.reason ?? null,
					createdAt: new Date(event.createdAt),
					metadata: { backfilled: true, source: 'pm2-logs' },
				},
			});
			inserted++;
		}

		console.log(`\nInserted ${inserted} backfilled clan history event(s).`);
	} finally {
		await prisma.$disconnect();
	}
}

main().catch((error) => {
	console.error('Backfill failed:', error);
	process.exitCode = 1;
});
