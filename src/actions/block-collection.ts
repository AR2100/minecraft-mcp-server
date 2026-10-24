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
const SAFE_SELF_DROP_BLOCKS = new Set([
  'dirt',
  'coarse_dirt',
  'sand',
  'red_sand',
  'cobblestone',
  'cobbled_deepslate'
]);
const SAFE_DROP_TRANSFORMS = new Map([
  ['stone', 'cobblestone'],
  ['deepslate', 'cobbled_deepslate']
]);
const WOOD_BLOCK_SUFFIXES = ['_log', '_wood', '_stem', '_hyphae', '_planks'];

const TOOL_PRIORITY = [
  'netherite',
  'diamond',
  'iron',
  'copper',
  'stone',
  'golden',
  'wooden'
];

export interface BlockCollectionArea {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export type BlockCollectionState = 'running' | 'completed' | 'incomplete' | 'stopped' | 'failed';

export interface BlockCollectionStatus {
  jobId: string;
  state: BlockCollectionState;
  blockType: string;
  dropItem: string;
  targetCount: number;
  collectedCount: number;
  blocksDug: number;
  skippedBlocks: number;
  area: BlockCollectionArea;
  startedAt: string;
  finishedAt?: string;
  message: string;
}

interface ActiveBlockCollection {
  status: BlockCollectionStatus;
  abortController: AbortController;
  releaseExclusiveOperation: () => void;
}

type InventoryItem = ReturnType<mineflayer.Bot['inventory']['items']>[number];
type MinecraftData = ReturnType<typeof minecraftData>;
type BlockData = MinecraftData['blocksByName'][string];
type ToolCategory = 'axe' | 'hoe' | 'pickaxe' | 'shovel';

export class BlockCollectionRunner {
  private activeCollection: ActiveBlockCollection | null = null;

  constructor(
    private factory: ToolFactory,
    private getBot: () => mineflayer.Bot
  ) {}

  start(blockType: string, targetCount: number, area: BlockCollectionArea): BlockCollectionStatus {
    this.validateRequest(targetCount, area);

    if (this.activeCollection?.status.state === 'running') {
      throw new Error('A block collection job is already running. Check its status or stop it first.');
    }

    const bot = this.getBot();
    const mcData = minecraftData(bot.version);
    const normalizedBlockType = this.normalizeBlockType(blockType);
    const blockData = mcData.blocksByName[normalizedBlockType];
    if (!blockData) {
      throw new Error(`Unknown block type '${blockType}' for Minecraft version ${bot.version}.`);
    }
    if (!blockData.diggable) {
      throw new Error(`Block type '${normalizedBlockType}' cannot be collected by digging.`);
    }

    const dropItem = this.resolveDropItem(mcData, normalizedBlockType, blockData);
    const itemData = mcData.itemsByName[dropItem];
    if (!itemData) {
      throw new Error(`Drop item data for '${dropItem}' is unavailable in Minecraft version ${bot.version}.`);
    }

    const availableCapacity = this.getAvailableItemCapacity(bot, dropItem, itemData.stackSize);
    if (targetCount > availableCapacity) {
      throw new Error(
        `The bot can hold only ${availableCapacity} additional ${dropItem} item(s) with its current inventory; ` +
        `${targetCount} were requested. Free inventory space or lower the target.`
      );
    }

    const tool = this.findMiningTool(bot, blockData, normalizedBlockType, dropItem);
    const releaseExclusiveOperation = this.factory.beginExclusiveOperation('block collection');
    const status: BlockCollectionStatus = {
      jobId: randomUUID(),
      state: 'running',
      blockType: normalizedBlockType,
      dropItem,
      targetCount,
      collectedCount: 0,
      blocksDug: 0,
      skippedBlocks: 0,
      area: { ...area },
      startedAt: new Date().toISOString(),
      message: 'Preparing to collect blocks.'
    };
    const collection: ActiveBlockCollection = {
      status,
      abortController: new AbortController(),
      releaseExclusiveOperation
    };

    this.activeCollection = collection;
    void this.runCollection(collection, bot, tool);
    return { ...status, area: { ...status.area } };
  }

  getStatus(): BlockCollectionStatus | null {
    const status = this.activeCollection?.status;
    return status ? { ...status, area: { ...status.area } } : null;
  }

  stop(): string {
    const collection = this.activeCollection;
    if (!collection) {
      return 'No block collection job has been started.';
    }
    if (collection.status.state !== 'running') {
      return `No block collection is running. The last job is ${collection.status.state}.`;
    }

    collection.status.message = 'Cancellation requested.';
    collection.abortController.abort();
    return `Cancellation requested for block collection job ${collection.status.jobId}.`;
  }

  private validateRequest(targetCount: number, area: BlockCollectionArea): void {
    if (!Number.isInteger(targetCount) || targetCount < 1 || targetCount > MAX_TARGET_COUNT) {
      throw new Error(`targetCount must be an integer from 1 to ${MAX_TARGET_COUNT}.`);
    }

    for (const [minimum, maximum, axis] of [
      [area.minX, area.maxX, 'X'],
      [area.minY, area.maxY, 'Y'],
      [area.minZ, area.maxZ, 'Z']
    ] as const) {
      if (!Number.isInteger(minimum) || !Number.isInteger(maximum) || minimum > maximum) {
        throw new Error(`The block collection area must have integer coordinates with min${axis} <= max${axis}.`);
      }
    }

    const volume =
      (area.maxX - area.minX + 1) *
      (area.maxY - area.minY + 1) *
      (area.maxZ - area.minZ + 1);
    if (!Number.isSafeInteger(volume) || volume > MAX_AREA_VOLUME) {
      throw new Error(`The block collection area cannot exceed ${MAX_AREA_VOLUME} blocks.`);
    }
  }

  private normalizeBlockType(blockType: string): string {
    const normalized = blockType.trim().toLowerCase().replace(/^minecraft:/, '');
    if (!normalized || normalized.includes(':')) {
      throw new Error(`Block type '${blockType}' must be a Minecraft block name, such as 'oak_log'.`);
    }
    return normalized;
  }

  private resolveDropItem(mcData: MinecraftData, blockType: string, blockData: BlockData): string {
    if (blockData.drops.length !== 1 || typeof blockData.drops[0] !== 'number') {
      throw new Error(
        `Block type '${blockType}' does not have a single predictable drop in the available Minecraft data. ` +
        'This collector currently rejects blocks with missing, variable, or multiple drop entries.'
      );
    }

    const dropItem = mcData.items[blockData.drops[0]];
    if (!dropItem) {
      throw new Error(`Minecraft data has no item entry for the drop from '${blockType}'.`);
    }
    const expectedDrop = SAFE_DROP_TRANSFORMS.get(blockType) ??
      (this.hasSafeSelfDrop(blockType) ? blockType : undefined);
    if (dropItem.name !== expectedDrop) {
      throw new Error(
        `Block type '${blockType}' is not in the collector's supported predictable-drop set. ` +
        'It supports selected dirt/sand/stone/deepslate blocks and vanilla wood blocks; conditional or variable drops are rejected.'
      );
    }

    return dropItem.name;
  }

  private hasSafeSelfDrop(blockType: string): boolean {
    return SAFE_SELF_DROP_BLOCKS.has(blockType) ||
      WOOD_BLOCK_SUFFIXES.some(suffix => blockType.endsWith(suffix));
  }

  private getAvailableItemCapacity(bot: mineflayer.Bot, itemName: string, stackSize: number): number {
    let capacity = 0;

    for (let slot = PLAYER_INVENTORY_START; slot <= PLAYER_INVENTORY_END; slot += 1) {
      const item = bot.inventory.slots[slot];
      if (!item) {
        capacity += stackSize;
      } else if (item.name === itemName) {
        capacity += Math.max(0, stackSize - item.count);
      }
    }

    return capacity;
  }

  private findMiningTool(
    bot: mineflayer.Bot,
    blockData: BlockData,
    blockType: string,
    dropItem: string
  ): InventoryItem | undefined {
    const toolCategory = this.getToolCategory(blockData.material);
    const harvestTools = blockData.harvestTools;
    const candidates = bot.inventory.items().filter(item => {
      if (toolCategory && !item.name.endsWith(`_${toolCategory}`)) {
        return false;
      }
      return !harvestTools || harvestTools[item.type] === true;
    });

    candidates.sort((first, second) =>
      this.getToolPriority(first.name) - this.getToolPriority(second.name)
    );

    const dropDiffersFromBlock = dropItem !== blockType;
    const usableTools = candidates.filter(item =>
      !dropDiffersFromBlock || !item.enchants.some(enchantment => enchantment.name === 'silk_touch')
    );

    if (usableTools.length === 0 && (toolCategory || harvestTools)) {
      if (dropDiffersFromBlock && candidates.length > 0) {
        throw new Error(
          `The available tool for '${blockType}' has Silk Touch, which may change its drop from '${dropItem}'. ` +
          'Provide a non-Silk-Touch tool to avoid collecting an unexpected item.'
        );
      }
      const requiredTool = toolCategory ? `a compatible ${toolCategory}` : 'a compatible tool';
      throw new Error(`The bot needs ${requiredTool} in its inventory to collect '${blockType}'.`);
    }

    return usableTools[0];
  }

  private getToolCategory(material?: string): ToolCategory | undefined {
    const match = material?.match(/^mineable\/(axe|hoe|pickaxe|shovel)$/);
    return match?.[1] as ToolCategory | undefined;
  }

  private getToolPriority(itemName: string): number {
    const material = TOOL_PRIORITY.findIndex(tier => itemName.startsWith(`${tier}_`));
    return material === -1 ? TOOL_PRIORITY.length : material;
  }

  private async runCollection(
    collection: ActiveBlockCollection,
    bot: mineflayer.Bot,
    tool: InventoryItem | undefined
  ): Promise<void> {
    const { status, abortController } = collection;
    const { signal } = abortController;
    let initialItemCount = 0;
    const abortBotActivity = () => this.stopBotActivity(bot, status.jobId, true);

    signal.addEventListener('abort', abortBotActivity, { once: true });

    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      this.throwIfAborted(signal);
      initialItemCount = this.getItemCount(bot, status.dropItem);
      if (tool) {
        await bot.equip(tool, 'hand');
      }

      const positions = this.findBlocksInArea(bot, status.area, status.blockType);
      if (positions.length === 0) {
        status.state = 'incomplete';
        status.message = `No loaded '${status.blockType}' blocks were found inside the requested area.`;
        return;
      }

      const startingPosition = bot.entity.position.clone();
      positions.sort((first, second) =>
        this.distanceBetween(first, startingPosition) - this.distanceBetween(second, startingPosition)
      );
      let nextPositionIndex = 0;
      status.message = `Found ${positions.length} '${status.blockType}' block(s) in the area.`;
      while (nextPositionIndex < positions.length && status.collectedCount < status.targetCount) {
        this.throwIfAborted(signal);
        const position = positions[nextPositionIndex];
        nextPositionIndex += 1;
        const block = bot.blockAt(position);
        if (!block || block.name !== status.blockType || this.isUnsafeToDig(bot, position)) {
          status.skippedBlocks += 1;
          continue;
        }

        try {
          if (!bot.canDigBlock(block) || !bot.canSeeBlock(block)) {
            await bot.pathfinder.goto(new goals.GoalNear(position.x, position.y, position.z, 2));
            this.throwIfAborted(signal);
          }

          const reachableBlock = bot.blockAt(position);
          if (
            !reachableBlock ||
            reachableBlock.name !== status.blockType ||
            this.isUnsafeToDig(bot, position)
          ) {
            status.skippedBlocks += 1;
            continue;
          }
          if (
            !bot.canDigBlock(reachableBlock) ||
            !reachableBlock.canHarvest(tool?.type ?? null)
          ) {
            status.skippedBlocks += 1;
            continue;
          }

          const previousItemCount = this.getItemCount(bot, status.dropItem);
          await bot.dig(reachableBlock);
          status.blocksDug += 1;
          status.message =
            `Waiting for '${status.dropItem}' from '${status.blockType}' at ` +
            `(${position.x}, ${position.y}, ${position.z}) to be picked up.`;

          let collected = await this.waitForItemCount(
            bot,
            status.dropItem,
            previousItemCount + 1,
            signal,
            500
          );
          if (!collected) {
            await bot.pathfinder.goto(new goals.GoalNear(position.x, position.y, position.z, 1));
            collected = await this.waitForItemCount(
              bot,
              status.dropItem,
              previousItemCount + 1,
              signal,
              PICKUP_CONFIRMATION_TIMEOUT_MS
            );
          }

          status.collectedCount = Math.min(
            status.targetCount,
            Math.max(0, this.getItemCount(bot, status.dropItem) - initialItemCount)
          );

          if (!collected) {
            status.state = 'incomplete';
            status.message =
              `Dug ${status.blocksDug} '${status.blockType}' block(s), but could not confirm pickup of ` +
              `'${status.dropItem}'. Stopped to avoid leaving more drops behind.`;
            return;
          }

          status.message =
            `Collected ${status.collectedCount} of ${status.targetCount} requested '${status.dropItem}' item(s) ` +
            `from '${status.blockType}' blocks.`;
        } catch (error) {
          this.throwIfAborted(signal);
          status.skippedBlocks += 1;
          const message = this.formatError(error);
          status.message = `Skipped '${status.blockType}' at (${position.x}, ${position.y}, ${position.z}): ${message}`;
          log('warn', `Block collection job ${status.jobId}: ${status.message}`);
        }
      }

      this.throwIfAborted(signal);
      if (status.collectedCount >= status.targetCount) {
        status.state = 'completed';
        status.message =
          `Collected the requested ${status.targetCount} '${status.dropItem}' item(s) from '${status.blockType}' blocks.`;
      } else {
        status.state = 'incomplete';
        status.message =
          `Area exhausted or remaining '${status.blockType}' blocks were unreachable after collecting ` +
          `${status.collectedCount} of ${status.targetCount} requested '${status.dropItem}' item(s).`;
      }
    } catch (error) {
      if (signal.aborted) {
        status.state = 'stopped';
        status.message =
          `Stopped after collecting ${status.collectedCount} of ${status.targetCount} requested ` +
          `'${status.dropItem}' item(s) from '${status.blockType}' blocks.`;
      } else {
        status.state = 'failed';
        status.message = `Block collection failed: ${this.formatError(error)}`;
        log('error', `Block collection job ${status.jobId}: ${status.message}`);
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
        log('warn', `Could not stop ${name} for block collection job ${jobId}: ${this.formatError(error)}`);
      }
    }
  }

  private findBlocksInArea(bot: mineflayer.Bot, area: BlockCollectionArea, blockType: string): Vec3[] {
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
          if (bot.blockAt(position)?.name === blockType) {
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

  private async waitForItemCount(
    bot: mineflayer.Bot,
    itemName: string,
    expectedCount: number,
    signal: AbortSignal,
    timeoutMs: number
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      this.throwIfAborted(signal);
      if (this.getItemCount(bot, itemName) >= expectedCount) {
        return true;
      }
      await this.delay(100, signal);
    }
    return this.getItemCount(bot, itemName) >= expectedCount;
  }

  private delay(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, milliseconds);
      const onAbort = () => {
        clearTimeout(timeout);
        reject(new Error('Block collection was cancelled.'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private getItemCount(bot: mineflayer.Bot, itemName: string): number {
    return bot.inventory.items()
      .filter(item => item.name === itemName)
      .reduce((count, item) => count + item.count, 0);
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new Error('Block collection was cancelled.');
    }
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
