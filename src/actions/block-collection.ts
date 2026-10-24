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
const MIN_HARVEST_BATCH_SIZE = 1;
const MAX_HARVEST_BATCH_SIZE = 64;
const DEFAULT_HARVEST_BATCH_SIZE = 8;
const MIN_COLLECTION_WINDOW_SECONDS = 1;
const MAX_COLLECTION_WINDOW_SECONDS = 30;
const DEFAULT_COLLECTION_WINDOW_SECONDS = 5;
const COLLECTION_POLL_INTERVAL_MS = 250;
const DROP_PICKUP_CONFIRMATION_TIMEOUT_MS = 750;
const MAX_DROP_PATHFINDING_TIMEOUT_MS = 5_000;
const MAX_DROP_PICKUP_DISTANCE = 8;
const MAX_DROP_FALL_DISTANCE = 8;
const NEARBY_HARVEST_DISTANCE = 4;
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

export interface BlockCollectionOptions {
  harvestBatchSize?: number;
  collectionWindowSeconds?: number;
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
  skippedDrops: number;
  harvestBatchSize: number;
  collectionWindowSeconds: number;
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

  start(
    blockType: string,
    targetCount: number,
    area: BlockCollectionArea,
    options: BlockCollectionOptions = {}
  ): BlockCollectionStatus {
    this.validateRequest(targetCount, area);
    const harvestBatchSize = options.harvestBatchSize ?? DEFAULT_HARVEST_BATCH_SIZE;
    const collectionWindowSeconds = options.collectionWindowSeconds ?? DEFAULT_COLLECTION_WINDOW_SECONDS;
    this.validateCadence(harvestBatchSize, collectionWindowSeconds);

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

    this.findMiningTool(bot, blockData, normalizedBlockType, dropItem);
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
      skippedDrops: 0,
      harvestBatchSize,
      collectionWindowSeconds,
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
    void this.runCollection(collection, bot, blockData);
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

  private validateCadence(harvestBatchSize: number, collectionWindowSeconds: number): void {
    if (
      !Number.isInteger(harvestBatchSize) ||
      harvestBatchSize < MIN_HARVEST_BATCH_SIZE ||
      harvestBatchSize > MAX_HARVEST_BATCH_SIZE
    ) {
      throw new Error(
        `harvestBatchSize must be an integer from ${MIN_HARVEST_BATCH_SIZE} to ${MAX_HARVEST_BATCH_SIZE}.`
      );
    }
    if (
      !Number.isFinite(collectionWindowSeconds) ||
      collectionWindowSeconds < MIN_COLLECTION_WINDOW_SECONDS ||
      collectionWindowSeconds > MAX_COLLECTION_WINDOW_SECONDS
    ) {
      throw new Error(
        `collectionWindowSeconds must be from ${MIN_COLLECTION_WINDOW_SECONDS} to ` +
        `${MAX_COLLECTION_WINDOW_SECONDS}.`
      );
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

  private findNearestBlockIndex(bot: mineflayer.Bot, positions: Vec3[]): number {
    let nearestIndex = -1;
    let nearestDistance = Number.POSITIVE_INFINITY;
    const currentPosition = bot.entity.position;

    for (let index = 0; index < positions.length; index += 1) {
      const distance = this.distanceBetween(positions[index], currentPosition);
      if (distance < nearestDistance) {
        nearestIndex = index;
        nearestDistance = distance;
      }
    }

    return nearestIndex;
  }

  private hasNearbyHarvestableBlock(
    bot: mineflayer.Bot,
    positions: Vec3[],
    blockType: string,
    tool: InventoryItem | undefined
  ): boolean {
    return positions.some(position => {
      if (
        this.distanceBetween(position, bot.entity.position) > NEARBY_HARVEST_DISTANCE ||
        this.isUnsafeToDig(bot, position)
      ) {
        return false;
      }
      const block = bot.blockAt(position);
      return Boolean(
        block &&
        block.name === blockType &&
        bot.canDigBlock(block) &&
        bot.canSeeBlock(block) &&
        block.canHarvest(tool?.type ?? null)
      );
    });
  }

  private async collectNearbyDrops(
    collection: ActiveBlockCollection,
    bot: mineflayer.Bot,
    initialItemCount: number,
    attemptedDropIds: Set<number>,
    deadline: number
  ): Promise<void> {
    const { status, abortController } = collection;
    const { signal } = abortController;

    while (Date.now() < deadline && status.collectedCount < status.targetCount) {
      this.throwIfAborted(signal);
      this.updateCollectedCount(bot, status, initialItemCount);
      const candidate = this.findNearbyDropEntities(bot, status, attemptedDropIds)[0];
      if (!candidate) {
        await this.delay(Math.min(COLLECTION_POLL_INTERVAL_MS, deadline - Date.now()), signal);
        continue;
      }

      attemptedDropIds.add(candidate.id);
      const previousItemCount = this.getItemCount(bot, status.dropItem);
      try {
        status.message =
          `Collecting nearby '${status.dropItem}' drops (${status.collectedCount} of ` +
          `${status.targetCount} collected).`;
        await this.gotoWithinCollectionWindow(
          bot,
          new goals.GoalNear(candidate.position.x, candidate.position.y, candidate.position.z, 1),
          deadline,
          signal
        );
        this.throwIfAborted(signal);
        const pickupWaitMs = Math.min(DROP_PICKUP_CONFIRMATION_TIMEOUT_MS, deadline - Date.now());
        if (pickupWaitMs > 0) {
          await this.waitForItemCount(
            bot,
            status.dropItem,
            previousItemCount + 1,
            signal,
            pickupWaitMs
          );
        }
        this.updateCollectedCount(bot, status, initialItemCount);
        if (this.getItemCount(bot, status.dropItem) === previousItemCount) {
          status.skippedDrops += 1;
          status.message =
            `Could not collect a nearby '${status.dropItem}' drop; continuing without blocking harvesting.`;
        }
      } catch (error) {
        this.throwIfAborted(signal);
        status.skippedDrops += 1;
        status.message = `Skipped a '${status.dropItem}' drop: ${this.formatError(error)}.`;
        log('warn', `Block collection job ${status.jobId}: ${status.message}`);
      }
    }
  }

  private async gotoWithinCollectionWindow(
    bot: mineflayer.Bot,
    goal: InstanceType<typeof goals.GoalNear>,
    deadline: number,
    signal: AbortSignal
  ): Promise<void> {
    this.throwIfAborted(signal);
    const timeoutMs = Math.min(MAX_DROP_PATHFINDING_TIMEOUT_MS, deadline - Date.now());
    if (timeoutMs <= 0) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
        if (error !== undefined) {
          reject(error);
        } else {
          resolve();
        }
      };
      const stopPathfinder = () => {
        try {
          bot.pathfinder.stop();
        } catch (error) {
          log(
            'warn',
            `Could not stop pathfinding for block collection job: ${this.formatError(error)}`
          );
        }
      };
      const onAbort = () => {
        stopPathfinder();
        finish(new Error('Block collection was cancelled.'));
      };
      const timeout = setTimeout(() => {
        stopPathfinder();
        finish(new Error('Timed out while approaching a nearby item drop.'));
      }, timeoutMs);
      signal.addEventListener('abort', onAbort, { once: true });

      try {
        void bot.pathfinder.goto(goal).then(
          () => finish(),
          (error: unknown) => finish(error)
        );
      } catch (error) {
        finish(error);
      }
    });
  }

  private findNearbyDropEntities(
    bot: mineflayer.Bot,
    status: BlockCollectionStatus,
    attemptedDropIds: Set<number> = new Set()
  ): Array<{ id: number; position: Vec3 }> {
    return Object.values(bot.entities)
      .filter(entity => {
        if (attemptedDropIds.has(entity.id) || !entity.isValid) {
          return false;
        }
        const droppedItem = entity.getDroppedItem();
        if (!droppedItem || droppedItem.name !== status.dropItem) {
          return false;
        }
        if (
          entity.position.y < status.area.minY - MAX_DROP_FALL_DISTANCE ||
          this.distanceBetween(entity.position, bot.entity.position) > MAX_DROP_PICKUP_DISTANCE ||
          this.isDropInHazard(bot, entity.position)
        ) {
          return false;
        }
        return true;
      })
      .sort((first, second) =>
        this.distanceBetween(first.position, bot.entity.position) -
        this.distanceBetween(second.position, bot.entity.position)
      )
      .map(entity => ({ id: entity.id, position: entity.position }));
  }

  private isDropInHazard(bot: mineflayer.Bot, position: Vec3): boolean {
    const itemBlockPosition = position.floored();
    const positionsToCheck = [
      itemBlockPosition,
      itemBlockPosition.offset(0, -1, 0),
      itemBlockPosition.offset(1, 0, 0),
      itemBlockPosition.offset(-1, 0, 0),
      itemBlockPosition.offset(0, 0, 1),
      itemBlockPosition.offset(0, 0, -1)
    ];
    return positionsToCheck.some(blockPosition => {
      const blockName = bot.blockAt(blockPosition)?.name;
      return blockName === 'fire' || blockName === 'soul_fire' ||
        blockName === 'lava' || blockName === 'flowing_lava';
    });
  }

  private updateCollectedCount(
    bot: mineflayer.Bot,
    status: BlockCollectionStatus,
    initialItemCount: number
  ): void {
    status.collectedCount = Math.min(
      status.targetCount,
      Math.max(0, this.getItemCount(bot, status.dropItem) - initialItemCount)
    );
  }

  private async runCollection(
    collection: ActiveBlockCollection,
    bot: mineflayer.Bot,
    blockData: BlockData
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

      const positions = this.findBlocksInArea(bot, status.area, status.blockType);
      status.message = `Found ${positions.length} '${status.blockType}' block(s) in the area.`;
      let harvestedSinceCollection = 0;
      const attemptedDropIds = new Set<number>();

      while (status.collectedCount < status.targetCount) {
        this.throwIfAborted(signal);
        this.updateCollectedCount(bot, status, initialItemCount);
        if (status.collectedCount >= status.targetCount) {
          break;
        }

        let miningTool: InventoryItem | undefined;
        try {
          miningTool = this.findMiningTool(bot, blockData, status.blockType, status.dropItem);
        } catch (error) {
          status.state = 'incomplete';
          status.message =
            `Stopped harvesting '${status.blockType}' because no suitable harvesting tool is available: ` +
            `${this.formatError(error)} Collected ${status.collectedCount} of ${status.targetCount} requested ` +
            `'${status.dropItem}' item(s).`;
          return;
        }
        if (miningTool) {
          await bot.equip(miningTool, 'hand');
        }

        const nextPositionIndex = this.findNearestBlockIndex(bot, positions);
        const nearbyHarvestableBlock = this.hasNearbyHarvestableBlock(
          bot,
          positions,
          status.blockType,
          miningTool
        );
        const nearbyDrop = this.findNearbyDropEntities(bot, status, attemptedDropIds).length > 0;
        const shouldCollectBeforeHarvest = nearbyDrop && !nearbyHarvestableBlock;

        if (shouldCollectBeforeHarvest || harvestedSinceCollection >= status.harvestBatchSize) {
          await this.collectNearbyDrops(
            collection,
            bot,
            initialItemCount,
            attemptedDropIds,
            Date.now() + status.collectionWindowSeconds * 1_000
          );
          harvestedSinceCollection = 0;
          continue;
        }

        if (nextPositionIndex < 0) {
          if (harvestedSinceCollection > 0) {
            await this.collectNearbyDrops(
              collection,
              bot,
              initialItemCount,
              attemptedDropIds,
              Date.now() + status.collectionWindowSeconds * 1_000
            );
          }
          break;
        }

        const [position] = positions.splice(nextPositionIndex, 1);
        try {
          let block = bot.blockAt(position);
          if (!block || block.name !== status.blockType || this.isUnsafeToDig(bot, position)) {
            status.skippedBlocks += 1;
            continue;
          }

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
          if (!bot.canDigBlock(reachableBlock)) {
            status.skippedBlocks += 1;
            continue;
          }
          if (!reachableBlock.canHarvest(miningTool?.type ?? null)) {
            status.state = 'incomplete';
            status.message =
              `Stopped harvesting '${status.blockType}' because the available tool cannot harvest this block ` +
              `for its drop. Collected ${status.collectedCount} of ${status.targetCount} requested ` +
              `'${status.dropItem}' item(s).`;
            return;
          }

          await bot.dig(reachableBlock);
          status.blocksDug += 1;
          harvestedSinceCollection += 1;
          this.updateCollectedCount(bot, status, initialItemCount);
          status.message =
            `Harvested ${status.blocksDug} '${status.blockType}' block(s) and collected ` +
            `${status.collectedCount} of ${status.targetCount} requested '${status.dropItem}' item(s).`;
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
          `${status.collectedCount} of ${status.targetCount} requested '${status.dropItem}' item(s) ` +
          `from ${status.blocksDug} harvested block(s).`;
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
