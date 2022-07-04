import { SqlHighlighter } from '@mikro-orm/sql-highlighter';
import Prisma from '@prisma/client';
import { container, SapphireClient, Store } from '@sapphire/framework';
import { bold, cyanBright, green } from 'colorette';
import type { ClientOptions } from 'discord.js';
import { ScheduleManager } from './schedule/ScheduleManager.js';
import { Task } from './schedule/tasks/Task.js';

export class UtilsBot extends SapphireClient {
	public schedule = new ScheduleManager(this);

	private readonly sqlHighlighter = new SqlHighlighter();

	public constructor(options: ClientOptions) {
		super(options);
		this.stores.register(new Store(Task as any, { name: 'tasks' }));
	}

	public fetchPrefix = () => null;
	public fetchLanguage = () => 'en-US';

	public async login(token?: string) {
		const prisma = new Prisma.PrismaClient({
			errorFormat: 'pretty',
			log: [
				{ emit: 'stdout', level: 'warn' },
				{ emit: 'stdout', level: 'error' },
				{ emit: 'event', level: 'query' },
			],
		});

		container.prisma = prisma;

		prisma.$on('query', (event) => {
			try {
				const paramsArray = JSON.parse(event.params) as unknown[];
				const newQuery = event.query.replace(/\$(\d+)/g, (_, number) => {
					const value = paramsArray[Number(number) - 1];

					if (typeof value === 'string') {
						return `"${value}"`;
					}

					if (Array.isArray(value)) {
						return `'${JSON.stringify(value)}'`;
					}

					return String(value);
				});

				container.logger.debug(`${cyanBright('prisma:query')} ${this.sqlHighlighter.highlight(newQuery)}`);
			} catch {
				container.logger.debug(
					`${cyanBright('prisma:query')} ${this.sqlHighlighter.highlight(`${event.query} PARAMETERS ${event.params}`)}`,
				);
			}
		});

		prisma.$use(async (params, next) => {
			const before = Date.now();

			const result = await next(params);

			const after = Date.now();

			this.logger.debug(
				`${cyanBright('prisma:query')} ${bold(`${params.model}.${params.action}`)} took ${bold(
					`${green(String(after - before))}ms`,
				)}`,
			);

			return result;
		});

		await prisma.$connect();

		this.logger.info('Logging in to Discord');
		return super.login(token);
	}

	public destroy() {
		void container.prisma.$disconnect();
		return super.destroy();
	}
}

declare module 'discord.js' {
	export interface Client {
		schedule: ScheduleManager;
	}
}

declare module '@sapphire/framework' {
	export interface StoreRegistryEntries {
		tasks: Store<Task>;
	}
}

declare module '@sapphire/pieces' {
	interface Container {
		prisma: Prisma.PrismaClient;
	}
}
