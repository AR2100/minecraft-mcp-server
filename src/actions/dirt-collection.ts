import { randomUUID } from 'node:crypto';
import minecraftData from 'minecraft-data';
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { log } from '../logger.js';
import { ToolFactory } from '../tool-factory.js';

const { goals } = pathfinderPkg;
const PLAYER_INVENTORY_START = 9;
const PLAYER_INVENTORY_END = 44;
const MAX_AREA_VOLUME = 65_536;
const MAX_TARGET_COUNT = 2_304;
const PICKUP_CONFIRMATION_TIMEOUT_MS = 10_000;

export interface DirtCollectionArea {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export type DirtCollectionState = 'running' | 'completed' | 'incomplete' | 'stopped' | 'failed';

export interface DirtCollectionStatus {
  jobId: string;
  state: DirtCollectionState;
  targetCount: number;
  collectedCount: number;
  blocksDug: number;
  skippedBlocks: number;
  area: DirtCollectionArea;
  startedAt: string;
  finishedAt?: string;
  message: string;
}

interface ActiveDirtCollection {
  status: DirtCollectionStatus;
  abortController: AbortController;
  releaseExclusiveOperation: () => void;
}

type InventoryItem = ReturnType<mineflayer.Bot['inventory']['items']>[number];

export class DirtCollectionRunner {
  private activeCollection: ActiveDirtCollection | null = null;

  constructor(
    private factory: ToolFactory,
    private getBot: () => mineflayer.Bot
  ) {}

  start(targetCount: number, area: DirtCollectionArea): DirtCollectionStatus {
    this.validateRequest(targetCount, area);

    if (this.activeCollection?.status.state === 'running') {
      throw new Error('A dirt collection job is already running. Check its status or stop it first.');
    }

    const bot = this.getBot();
    const dirtStackSize = minecraftData(bot.version).itemsByName.dirt?.stackSize;
    if (!dirtStackSize) {
      throw new Error(`Dirt item data is unavailable for Minecraft version ${bot.version}.`);
    }

    const availableCapacity = this.getAvailableDirtCapacity(bot, dirtStackSize);
    if (targetCount > availableCapacity) {
      throw new Error(
        `The bot can hold only ${availableCapacity} additional dirt blocks with its current inventory; ` +
        `${targetCount} were requested. Free inventory space or lower the target.`
      );
    }

    const shovel = this.findBestShovel(bot);
    if (!shovel) {
      throw new Error('The bot needs a shovel in its inventory before it can start collecting dirt.');
    }

    const releaseExclusiveOperation = this.factory.beginExclusiveOperation('dirt collection');
    const status: DirtCollectionStatus = {
      jobId: randomUUID(),
      state: 'running',
      targetCount,
      collectedCount: 0,
      blocksDug: 0,
      skippedBlocks: 0,
      area: { ...area },
      startedAt: new Date().toISOString(),
      message: 'Preparing to collect dirt.'
    };
    const collection: ActiveDirtCollection = {
      status,
      abortController: new AbortController(),
      releaseExclusiveOperation
    };

    this.activeCollection = collection;
    void this.runCollection(collection, bot, shovel);
    return { ...status, area: { ...status.area } };
  }

  getStatus(): DirtCollectionStatus | null {
    const status = this.activeCollection?.status;
    return status ? { ...status, area: { ...status.area } } : null;
  }

  stop(): string {
    const collection = this.activeCollection;
    if (!collection) {
      return 'No dirt collection job has been started.';
    }
    if (collection.status.state !== 'running') {
      return `No dirt collection is running. The last job is ${collection.status.state}.`;
    }

    collection.status.message = 'Cancellation requested.';
    collection.abortController.abort();
    return `Cancellation requested for dirt collection job ${collection.status.jobId}.`;
  }

  private validateRequest(targetCount: number, area: DirtCollectionArea): void {
    if (!Number.isInteger(targetCount) || targetCount < 1 || targetCount > MAX_TARGET_COUNT) {
      throw new Error(`targetCount must be an integer from 1 to ${MAX_TARGET_COUNT}.`);
    }

    for (const [minimum, maximum, axis] of [
      [area.minX, area.maxX, 'X'],
      [area.minY, area.maxY, 'Y'],
      [area.minZ, area.maxZ, 'Z']
    ] as const) {
      if (!Number.isInteger(minimum) || !Number.isInteger(maximum) || minimum > maximum) {
        throw new Error(`The dirt collection area must have integer coordinates with min${axis} <= max${axis}.`);
      }
    }

    const volume =
      (area.maxX - area.minX + 1) *
      (area.maxY - area.minY + 1) *
      (area.maxZ - area.minZ + 1);
    if (!Number.isSafeInteger(volume) || volume > MAX_AREA_VOLUME) {
      throw new Error(`The dirt collection area cannot exceed ${MAX_AREA_VOLUME} blocks.`);
    }
  }

  private getAvailableDirtCapacity(bot: mineflayer.Bot, stackSize: number): number {
    let capacity = 0;

    for (let slot = PLAYER_INVENTORY_START; slot <= PLAYER_INVENTORY_END; slot += 1) {
      const item = bot.inventory.slots[slot];
      if (!item) {
        capacity += stackSize;
      } else if (item.name === 'dirt') {
        capacity += Math.max(0, stackSize - item.count);
      }
    }

    return capacity;
  }

  private findBestShovel(bot: mineflayer.Bot): InventoryItem | undefined {
    const shovelOrder = [
      'netherite_shovel',
      'diamond_shovel',
      'iron_shovel',
      'stone_shovel',
      'golden_shovel',
      'wooden_shovel'
    ];
    const items = bot.inventory.items();
    for (const name of shovelOrder) {
      const item = items.find(candidate => candidate.name === name);
      if (item) {
        return item;
      }
    }
    return undefined;
  }

  private async runCollection(
    collection: ActiveDirtCollection,
    bot: mineflayer.Bot,
    shovel: InventoryItem
  ): Promise<void> {
    const { status, abortController } = collection;
    const { signal } = abortController;
    let initialDirtCount = 0;
    const abortBotActivity = () => this.stopBotActivity(bot, status.jobId, true);

    signal.addEventListener('abort', abortBotActivity, { once: true });

    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      this.throwIfAborted(signal);
      initialDirtCount = this.getDirtCount(bot);
      await bot.equip(shovel, 'hand');

      const positions = this.findDirtInArea(bot, status.area);
      if (positions.length === 0) {
        status.state = 'incomplete';
        status.message = 'No loaded dirt blocks were found inside the requested area.';
        return;
      }

      const startingPosition = bot.entity.position.clone();
      positions.sort((first, second) =>
        this.distanceBetween(first, startingPosition) - this.distanceBetween(second, startingPosition)
      );
      let nextPositionIndex = 0;
      status.message = `Found ${positions.length} dirt block(s) in the area.`;
      while (nextPositionIndex < positions.length && status.collectedCount < status.targetCount) {
        this.throwIfAborted(signal);
        const position = positions[nextPositionIndex];
        nextPositionIndex += 1;
        const block = bot.blockAt(position);
        if (!block || block.name !== 'dirt' || this.isUnsafeToDig(bot, position)) {
          status.skippedBlocks += 1;
          continue;
        }

        try {
          if (!bot.canDigBlock(block) || !bot.canSeeBlock(block)) {
            await bot.pathfinder.goto(new goals.GoalNear(position.x, position.y, position.z, 2));
            this.throwIfAborted(signal);
          }

          const reachableBlock = bot.blockAt(position);
          if (!reachableBlock || reachableBlock.name !== 'dirt' || this.isUnsafeToDig(bot, position)) {
            status.skippedBlocks += 1;
            continue;
          }
          if (!bot.canDigBlock(reachableBlock)) {
            status.skippedBlocks += 1;
            continue;
          }

          const previousDirtCount = this.getDirtCount(bot);
          await bot.dig(reachableBlock);
          status.blocksDug += 1;
          status.message = `Waiting for the dirt drop at (${position.x}, ${position.y}, ${position.z}) to be picked up.`;

          let collected = await this.waitForDirtCount(bot, previousDirtCount + 1, signal, 500);
          if (!collected) {
            await bot.pathfinder.goto(new goals.GoalNear(position.x, position.y, position.z, 1));
            collected = await this.waitForDirtCount(
              bot,
              previousDirtCount + 1,
              signal,
              PICKUP_CONFIRMATION_TIMEOUT_MS
            );
          }

          status.collectedCount = Math.min(
            status.targetCount,
            Math.max(0, this.getDirtCount(bot) - initialDirtCount)
          );

          if (!collected) {
            status.state = 'incomplete';
            status.message = `Dug ${status.blocksDug} block(s), but could not confirm pickup of the latest dirt drop. Stopped to avoid leaving more drops behind.`;
            return;
          }

          status.message = `Collected ${status.collectedCount} of ${status.targetCount} requested dirt blocks.`;
        } catch (error) {
          this.throwIfAborted(signal);
          status.skippedBlocks += 1;
          const message = this.formatError(error);
          status.message = `Skipped block at (${position.x}, ${position.y}, ${position.z}): ${message}`;
          log('warn', `Dirt collection job ${status.jobId}: ${status.message}`);
        }
      }

      this.throwIfAborted(signal);
      if (status.collectedCount >= status.targetCount) {
        status.state = 'completed';
        status.message = `Collected the requested ${status.targetCount} dirt blocks.`;
      } else {
        status.state = 'incomplete';
        status.message =
          `Area exhausted or remaining dirt was unreachable after collecting ${status.collectedCount} of ` +
          `${status.targetCount} requested dirt blocks.`;
      }
    } catch (error) {
      if (signal.aborted) {
        status.state = 'stopped';
        status.message = `Stopped after collecting ${status.collectedCount} of ${status.targetCount} requested dirt blocks.`;
      } else {
        status.state = 'failed';
        status.message = `Dirt collection failed: ${this.formatError(error)}`;
        log('error', `Dirt collection job ${status.jobId}: ${status.message}`);
      }
    } finally {
      signal.removeEventListener('abort', abortBotActivity);
      this.stopBotActivity(bot, status.jobId, false);
      status.finishedAt = new Date().toISOString();
      collection.releaseExclusiveOperation();
    }
  }

  private stopBotActivity(bot: mineflayer.Bot, jobId: string, stopPathfinder: boolean): void {
    const actions: Array<[string, () => void]> = [['control states', () => bot.clearControlStates()]];
    if (stopPathfinder) {
      actions.unshift(
        ['digging', () => bot.stopDigging()],
        ['pathfinder', () => bot.pathfinder.stop()]
      );
    }

    for (const [name, stop] of actions) {
      try {
        stop();
      } catch (error) {
        log('warn', `Could not stop ${name} for dirt collection job ${jobId}: ${this.formatError(error)}`);
      }
    }
  }

  private findDirtInArea(bot: mineflayer.Bot, area: DirtCollectionArea): Vec3[] {
    const positions: Vec3[] = [];
    const feetPosition = bot.entity.position.floored();
    const supportPosition = feetPosition.offset(0, -1, 0);
    const headPosition = feetPosition.offset(0, 1, 0);

    for (let x = area.minX; x <= area.maxX; x += 1) {
      for (let y = area.minY; y <= area.maxY; y += 1) {
        for (let z = area.minZ; z <= area.maxZ; z += 1) {
          const position = new Vec3(x, y, z);
          if (position.equals(supportPosition) || position.equals(feetPosition) || position.equals(headPosition)) {
            continue;
          }
          if (bot.blockAt(position)?.name === 'dirt') {
            positions.push(position);
          }
        }
      }
    }

    return positions;
  }

  private distanceBetween(first: Vec3, second: Vec3): number {
    return Math.hypot(first.x - second.x, first.y - second.y, first.z - second.z);
  }

  private isUnsafeToDig(bot: mineflayer.Bot, position: Vec3): boolean {
    const feetPosition = bot.entity.position.floored();
    return position.equals(feetPosition.offset(0, -1, 0)) ||
      position.equals(feetPosition) ||
      position.equals(feetPosition.offset(0, 1, 0));
  }

  private async waitForDirtCount(
    bot: mineflayer.Bot,
    expectedCount: number,
    signal: AbortSignal,
    timeoutMs: number
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      this.throwIfAborted(signal);
      if (this.getDirtCount(bot) >= expectedCount) {
        return true;
      }
      await this.delay(100, signal);
    }
    return this.getDirtCount(bot) >= expectedCount;
  }

  private delay(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, milliseconds);
      const onAbort = () => {
        clearTimeout(timeout);
        reject(new Error('Dirt collection was cancelled.'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private getDirtCount(bot: mineflayer.Bot): number {
    return bot.inventory.items()
      .filter(item => item.name === 'dirt')
      .reduce((count, item) => count + item.count, 0);
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new Error('Dirt collection was cancelled.');
    }
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
