/* eslint-disable no-multi-assign */
import { container } from '@sapphire/framework';
import { Cron, TimerManager } from '@sapphire/time-utilities';
import type { UtilsBot } from '../UtilsBot';
import { ResponseType, ResponseValue, ScheduleEntity } from './ScheduleEntity.js';

export class ScheduleManager {
	public readonly client: UtilsBot;
	public queue: ScheduleEntity[] = [];

	// eslint-disable-next-line @typescript-eslint/explicit-member-accessibility
	#interval: NodeJS.Timer | null = null;

	public constructor(client: UtilsBot) {
		this.client = client;
	}

	public async init() {
		const entries = await container.prisma.schedule.findMany();

		for (const entry of entries) this.insertInQueue(new ScheduleEntity(entry).setup(this).resume());
		this.checkInterval();
	}

	public async add(taskId: string, timeResolvable: TimeResolvable, data?: string) {
		if (!this.client.stores.get('tasks').has(taskId)) throw new Error(`The task '${taskId}' does not exist.`);

		const [time, cron] = this.resolveTime(timeResolvable);

		const d = await container.prisma.schedule.create({
			data: {
				task_id: taskId,
				time,
				recurring: cron?.cron ?? null,
				data,
			},
		});

		const entry = new ScheduleEntity(d);

		this.insertInQueue(entry.setup(this).resume());
		this.checkInterval();
		return entry;
	}

	public async remove(entityOrID: ScheduleEntity | number) {
		if (typeof entityOrID === 'number') {
			entityOrID = this.queue.find((entity) => entity.id === entityOrID)!;
			if (!entityOrID) return false;
		}

		entityOrID.pause();
		await container.prisma.schedule.delete({ where: { id: entityOrID.id } });

		this.removeFromQueue(entityOrID);
		this.checkInterval();
		return true;
	}

	public async execute() {
		if (this.queue.length) {
			// Process the active tasks, they're sorted by the time they end
			const now = Date.now();
			const execute = [];
			for (const entry of this.queue) {
				if (entry.time.getTime() > now) break;
				if (entry['paused']) {
					container.logger.debug(
						`Found schedule entity for task ${entry.taskID} that was paused, yet expected to run. Will resume it forcefully.`,
					);
					entry.resume();
				}
				execute.push(entry.run());
			}

			// Check if the Schedule has a task to run and run them if they exist
			if (!execute.length) return;
			await this.handleResponses(await Promise.all(execute));
		}

		this.checkInterval();
	}

	private async handleResponses(responses: readonly ResponseValue[]) {
		const em = container.prisma.schedule;
		const updated: ScheduleEntity[] = [];
		const removed: ScheduleEntity[] = [];
		try {
			for (const response of responses) {
				// Pause so it is not re-run
				response.entry.pause();

				switch (response.type) {
					case ResponseType.Delay: {
						const time = (response.entry.time = new Date(response.entry.time.getTime() + response.value));
						updated.push(response.entry);
						await em.update({ where: { id: response.entry.id }, data: { time } });
						continue;
					}
					case ResponseType.Finished: {
						removed.push(response.entry);
						try {
							await em.delete({ where: { id: response.entry.id } });
						} catch (err) {
							container.logger.warn(`Failed to delete schedule entry ${response.entry.id}, possibly deleted already.`);
						}
						continue;
					}
					case ResponseType.Ignore: {
						continue;
					}
					case ResponseType.Update: {
						const time = (response.entry.time = response.value);
						updated.push(response.entry);
						await em.update({ where: { id: response.entry.id }, data: { time } });
					}
				}
			}

			// Update cache
			// - Remove expired entries
			for (const entry of removed) {
				this.removeFromQueue(entry);
			}

			// - Update indexes
			for (const entry of updated) {
				const index = this.queue.findIndex((entity) => entity === entry);
				if (index === -1) continue;

				this.queue.splice(index, 1);
				this.insertInQueue(entry);

				// Resume so it can be run again
				entry.resume();
			}
		} catch (error) {
			this.client.emit('wtf', error);
		}
	}

	private insertInQueue(entity: ScheduleEntity) {
		const index = this.queue.findIndex((entry) => entry.time > entity.time);
		if (index === -1) this.queue.push(entity);
		else this.queue.splice(index, 0, entity);

		return entity;
	}

	private removeFromQueue(entity: ScheduleEntity) {
		const index = this.queue.findIndex((entry) => entry === entity);
		if (index !== -1) this.queue.splice(index, 1);
	}

	/**
	 * Clear the current interval
	 */
	private clearInterval(): void {
		if (this.#interval) {
			TimerManager.clearInterval(this.#interval);
			this.#interval = null;
		}
	}

	/**
	 * Sets the interval when needed
	 */
	private checkInterval(): void {
		if (!this.queue.length) this.clearInterval();
		else if (!this.#interval) this.#interval = TimerManager.setInterval(this.execute.bind(this), 5000);
	}

	/**
	 * Resolve the time and cron
	 * @param time The time or Cron pattern
	 */
	private resolveTime(time: TimeResolvable): [Date, Cron | null] {
		if (time instanceof Date) return [time, null];
		if (time instanceof Cron) return [time.next(), time];
		if (typeof time === 'number') return [new Date(time), null];
		if (typeof time === 'string') {
			const cron = new Cron(time);
			return [cron.next(), cron];
		}
		throw new Error('invalid time passed');
	}
}

export type TimeResolvable = number | Date | string | Cron;
