import { randomUUID } from 'node:crypto';
import minecraftData from 'minecraft-data';
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { log } from '../logger.js';
import { ToolFactory } from '../tool-factory.js';
import { findCompatibleMiningTool, InventoryItem } from './mining-tools.js';

const { goals } = pathfinderPkg;
const DEFAULT_LENGTH = 32;
const MAX_LENGTH = 128;
const DEFAULT_TUNNEL_WIDTH = 1;
const DEFAULT_TUNNEL_HEIGHT = 2;
const DEFAULT_BRANCH_SEARCH_RADIUS = 4;
const MAX_BRANCH_SEARCH_RADIUS = 8;
const DEFAULT_MAX_ORE_BLOCKS_PER_BRANCH = 32;
const MAX_ORE_BLOCKS_PER_BRANCH = 128;
const DEFAULT_TORCH_SPACING = 8;
const MAX_TORCH_SPACING = 64;
const MAX_STAIRCASE_STEPS = 128;
const PATHFINDING_TIMEOUT_MS = 30_000;
const DROP_HAZARDS = new Set(['fire', 'soul_fire', 'lava', 'flowing_lava']);
const AIR_BLOCKS = new Set(['air', 'cave_air', 'void_air']);
const DEFAULT_ORES = [
  'coal_ore',
  'deepslate_coal_ore',
  'iron_ore',
  'deepslate_iron_ore',
  'copper_ore',
  'deepslate_copper_ore',
  'gold_ore',
  'deepslate_gold_ore',
  'redstone_ore',
  'deepslate_redstone_ore',
  'lapis_ore',
  'deepslate_lapis_ore',
  'diamond_ore',
  'deepslate_diamond_ore',
  'emerald_ore',
  'deepslate_emerald_ore',
  'nether_quartz_ore',
  'nether_gold_ore',
  'ancient_debris'
];

export type StripMiningDirection = 'north' | 'south' | 'east' | 'west';

export interface StripMiningOptions {
  length?: number;
  targetY?: number;
  direction?: StripMiningDirection;
  tunnelWidth?: number;
  tunnelHeight?: number;
  branchOreTypes?: string[];
  branchSearchRadius?: number;
  maxOreBlocksPerBranch?: number;
  placeTorches?: boolean;
  torchSpacing?: number;
}

export type StripMiningState = 'running' | 'completed' | 'incomplete' | 'stopped' | 'failed';

export interface StripMiningStatus {
  jobId: string;
  state: StripMiningState;
  direction: StripMiningDirection;
  startY: number;
  targetY: number;
  length: number;
  tunnelWidth: number;
  tunnelHeight: number;
  branchOreTypes: string[];
  branchSearchRadius: number;
  maxOreBlocksPerBranch: number;
  placeTorches: boolean;
  torchSpacing: number;
  staircaseSteps: number;
  stepsMined: number;
  blocksDug: number;
  oreBlocksDug: number;
  branchOreBlocksDug: number;
  skippedBlocks: number;
  torchesPlaced: number;
  startedAt: string;
  finishedAt?: string;
  message: string;
}

interface ActiveStripMine {
  status: StripMiningStatus;
  abortController: AbortController;
  releaseExclusiveOperation: () => void;
}

interface DirectionVector {
  x: number;
  z: number;
}

interface MineBlockOptions {
  oreTypes: Set<string>;
}

type MinecraftData = ReturnType<typeof minecraftData>;

class StripMiningStopError extends Error {}

export class StripMiningRunner {
  private activeMine: ActiveStripMine | null = null;

  constructor(
    private factory: ToolFactory,
    private getBot: () => mineflayer.Bot
  ) {}

  start(options: StripMiningOptions = {}): StripMiningStatus {
    if (this.activeMine?.status.state === 'running') {
      throw new Error('A strip mining job is already running. Check its status or stop it first.');
    }

    const bot = this.getBot();
    const mcData = minecraftData(bot.version);
    const startPosition = bot.entity.position.floored();
    const direction = options.direction ?? this.getFacingDirection(bot.entity.yaw);
    const length = options.length ?? DEFAULT_LENGTH;
    const targetY = options.targetY ?? startPosition.y;
    const tunnelWidth = options.tunnelWidth ?? DEFAULT_TUNNEL_WIDTH;
    const tunnelHeight = options.tunnelHeight ?? DEFAULT_TUNNEL_HEIGHT;
    const branchSearchRadius = options.branchSearchRadius ?? DEFAULT_BRANCH_SEARCH_RADIUS;
    const maxOreBlocksPerBranch = options.maxOreBlocksPerBranch ?? DEFAULT_MAX_ORE_BLOCKS_PER_BRANCH;
    const placeTorches = options.placeTorches ?? true;
    const torchSpacing = options.torchSpacing ?? DEFAULT_TORCH_SPACING;
    const branchOreTypes = this.resolveBranchOreTypes(mcData, options.branchOreTypes);

    this.validateOptions({
      length,
      targetY,
      startY: startPosition.y,
      tunnelWidth,
      tunnelHeight,
      branchSearchRadius,
      maxOreBlocksPerBranch,
      torchSpacing
    });

    const stone = mcData.blocksByName.stone;
    if (!stone?.diggable) {
      throw new Error(`Stone mining is unavailable for Minecraft version ${bot.version}.`);
    }
    findCompatibleMiningTool(bot, stone, 'stone', 'cobblestone');

    const releaseExclusiveOperation = this.factory.beginExclusiveOperation('strip mining');
    const status: StripMiningStatus = {
      jobId: randomUUID(),
      state: 'running',
      direction,
      startY: startPosition.y,
      targetY,
      length,
      tunnelWidth,
      tunnelHeight,
      branchOreTypes,
      branchSearchRadius,
      maxOreBlocksPerBranch,
      placeTorches,
      torchSpacing,
      staircaseSteps: 0,
      stepsMined: 0,
      blocksDug: 0,
      oreBlocksDug: 0,
      branchOreBlocksDug: 0,
      skippedBlocks: 0,
      torchesPlaced: 0,
      startedAt: new Date().toISOString(),
      message: 'Preparing the mineshaft.'
    };
    const activeMine: ActiveStripMine = {
      status,
      abortController: new AbortController(),
      releaseExclusiveOperation
    };

    this.activeMine = activeMine;
    void this.run(activeMine, bot, mcData);
    return { ...status, branchOreTypes: [...status.branchOreTypes] };
  }

  getStatus(): StripMiningStatus | null {
    const status = this.activeMine?.status;
    return status ? { ...status, branchOreTypes: [...status.branchOreTypes] } : null;
  }

  stop(): string {
    const activeMine = this.activeMine;
    if (!activeMine) {
      return 'No strip mining job has been started.';
    }
    if (activeMine.status.state !== 'running') {
      return `No strip mining job is running. The last job is ${activeMine.status.state}.`;
    }

    activeMine.status.message = 'Cancellation requested.';
    activeMine.abortController.abort();
    return `Cancellation requested for strip mining job ${activeMine.status.jobId}.`;
  }

  private validateOptions(options: {
    length: number;
    targetY: number;
    startY: number;
    tunnelWidth: number;
    tunnelHeight: number;
    branchSearchRadius: number;
    maxOreBlocksPerBranch: number;
    torchSpacing: number;
  }): void {
    if (!Number.isInteger(options.length) || options.length < 1 || options.length > MAX_LENGTH) {
      throw new Error(`length must be an integer from 1 to ${MAX_LENGTH}.`);
    }
    if (!Number.isInteger(options.targetY) || options.targetY < -64 || options.targetY > 320) {
      throw new Error('targetY must be an integer from -64 to 320.');
    }
    if (options.targetY > options.startY) {
      throw new Error('targetY cannot be above the bot. Strip mining only builds a descending staircase.');
    }
    if (options.startY - options.targetY > MAX_STAIRCASE_STEPS) {
      throw new Error(`The staircase cannot exceed ${MAX_STAIRCASE_STEPS} steps.`);
    }
    if (!Number.isInteger(options.tunnelWidth) || options.tunnelWidth < 1 || options.tunnelWidth > 5) {
      throw new Error('tunnelWidth must be an integer from 1 to 5.');
    }
    if (!Number.isInteger(options.tunnelHeight) || options.tunnelHeight < 2 || options.tunnelHeight > 5) {
      throw new Error('tunnelHeight must be an integer from 2 to 5.');
    }
    if (
      !Number.isInteger(options.branchSearchRadius) ||
      options.branchSearchRadius < 1 ||
      options.branchSearchRadius > MAX_BRANCH_SEARCH_RADIUS
    ) {
      throw new Error(`branchSearchRadius must be an integer from 1 to ${MAX_BRANCH_SEARCH_RADIUS}.`);
    }
    if (
      !Number.isInteger(options.maxOreBlocksPerBranch) ||
      options.maxOreBlocksPerBranch < 1 ||
      options.maxOreBlocksPerBranch > MAX_ORE_BLOCKS_PER_BRANCH
    ) {
      throw new Error(
        `maxOreBlocksPerBranch must be an integer from 1 to ${MAX_ORE_BLOCKS_PER_BRANCH}.`
      );
    }
    if (!Number.isInteger(options.torchSpacing) || options.torchSpacing < 1 || options.torchSpacing > MAX_TORCH_SPACING) {
      throw new Error(`torchSpacing must be an integer from 1 to ${MAX_TORCH_SPACING}.`);
    }
  }

  private resolveBranchOreTypes(mcData: MinecraftData, requestedTypes?: string[]): string[] {
    const types = requestedTypes ?? DEFAULT_ORES.filter(name => Boolean(mcData.blocksByName[name]));
    const uniqueTypes = [...new Set(types.map(name => this.normalizeBlockName(name)))];

    for (const name of uniqueTypes) {
      const blockData = mcData.blocksByName[name];
      if (!blockData) {
        throw new Error(`Unknown branch block type '${name}' for Minecraft version ${mcData.version.minecraftVersion}.`);
      }
      if (!name.endsWith('_ore') && name !== 'ancient_debris') {
        throw new Error(`Branch target '${name}' must be an ore block or ancient_debris.`);
      }
      if (!blockData.diggable) {
        throw new Error(`Branch target '${name}' cannot be mined.`);
      }
    }

    return uniqueTypes;
  }

  private normalizeBlockName(blockName: string): string {
    const normalized = blockName.trim().toLowerCase().replace(/^minecraft:/, '');
    if (!normalized || normalized.includes(':')) {
      throw new Error(`Invalid Minecraft block name '${blockName}'.`);
    }
    return normalized;
  }

  private getFacingDirection(yaw: number): StripMiningDirection {
    const facingX = -Math.sin(yaw);
    const facingZ = Math.cos(yaw);
    if (Math.abs(facingX) > Math.abs(facingZ)) {
      return facingX > 0 ? 'east' : 'west';
    }
    return facingZ > 0 ? 'south' : 'north';
  }

  private getDirectionVector(direction: StripMiningDirection): DirectionVector {
    switch (direction) {
      case 'north': return { x: 0, z: -1 };
      case 'south': return { x: 0, z: 1 };
      case 'east': return { x: 1, z: 0 };
      case 'west': return { x: -1, z: 0 };
    }
  }

  private async run(activeMine: ActiveStripMine, bot: mineflayer.Bot, mcData: MinecraftData): Promise<void> {
    const { status, abortController } = activeMine;
    const { signal } = abortController;
    const direction = this.getDirectionVector(status.direction);
    const oreTypes = new Set(status.branchOreTypes);
    const mineOptions: MineBlockOptions = { oreTypes };
    const startPosition = bot.entity.position.floored();
    let startAnchor = new Vec3(startPosition.x, status.targetY, startPosition.z);
    const abortBotActivity = () => this.stopBotActivity(bot, status.jobId, true);
    signal.addEventListener('abort', abortBotActivity, { once: true });

    try {
      this.throwIfAborted(signal);
      if (status.targetY < startPosition.y) {
        startAnchor = await this.descendStaircase(activeMine, bot, mcData, direction, mineOptions);
      }

      status.message = `Mining a ${status.tunnelWidth}x${status.tunnelHeight} tunnel ${status.direction}.`;
      for (let step = 1; step <= status.length; step += 1) {
        this.throwIfAborted(signal);
        const center = startAnchor.offset(direction.x * step, 0, direction.z * step);
        const slicePositions = this.getTunnelSlice(center, direction, status.tunnelWidth, status.tunnelHeight);
        slicePositions.sort((first, second) =>
          this.distanceBetween(first, bot.entity.position) - this.distanceBetween(second, bot.entity.position)
        );

        for (const position of slicePositions) {
          this.throwIfAborted(signal);
          const block = bot.blockAt(position);
          if (!block || AIR_BLOCKS.has(block.name)) {
            continue;
          }
          await this.mineBlock(activeMine, bot, mcData, position, mineOptions);
          await this.collectVisibleOres(
            activeMine,
            bot,
            mcData,
            bot.entity.position.floored(),
            mineOptions
          );
        }

        await this.gotoPosition(activeMine, bot, center, 0);
        status.stepsMined = step;
        status.message =
          `Mined ${status.stepsMined} of ${status.length} tunnel steps; ` +
          `${status.oreBlocksDug} configured ore block(s) harvested.`;

        if (status.placeTorches && step % status.torchSpacing === 0) {
          await this.placeTorchBehind(activeMine, bot, center.offset(-direction.x, 0, -direction.z));
        }
      }

      this.throwIfAborted(signal);
      status.state = 'completed';
      status.message =
        `Completed a ${status.length}-step ${status.tunnelWidth}x${status.tunnelHeight} strip mine at Y=${status.targetY}; ` +
        `harvested ${status.oreBlocksDug} configured ore block(s) and placed ${status.torchesPlaced} torch(es).`;
    } catch (error) {
      if (signal.aborted) {
        status.state = 'stopped';
        status.message =
          `Stopped strip mining after ${status.stepsMined} of ${status.length} steps; ` +
          `${status.oreBlocksDug} ore block(s) harvested.`;
      } else if (error instanceof StripMiningStopError) {
        status.state = 'incomplete';
        status.message =
          `${error.message} Stopped after ${status.stepsMined} of ${status.length} tunnel steps; ` +
          `${status.oreBlocksDug} ore block(s) harvested.`;
      } else {
        status.state = 'failed';
        status.message = `Strip mining failed: ${this.formatError(error)}`;
        log('error', `Strip mining job ${status.jobId}: ${status.message}`);
      }
    } finally {
      signal.removeEventListener('abort', abortBotActivity);
      this.stopBotActivity(bot, status.jobId, false);
      status.finishedAt = new Date().toISOString();
      activeMine.releaseExclusiveOperation();
    }
  }

  private async descendStaircase(
    activeMine: ActiveStripMine,
    bot: mineflayer.Bot,
    mcData: MinecraftData,
    direction: DirectionVector,
    options: MineBlockOptions
  ): Promise<Vec3> {
    const status = activeMine.status;
    status.message = `Building a staircase down to Y=${status.targetY}.`;

    while (bot.entity.position.floored().y > status.targetY) {
      this.throwIfAborted(activeMine.abortController.signal);
      const current = bot.entity.position.floored();
      const nextFeet = current.offset(direction.x, -1, direction.z);
      for (const position of [nextFeet, nextFeet.offset(0, 1, 0)]) {
        const block = bot.blockAt(position);
        if (!block) {
          throw new StripMiningStopError(`Cannot continue the staircase because the block at ${position} is not loaded.`);
        }
        if (AIR_BLOCKS.has(block.name)) {
          continue;
        }
        await this.mineBlock(activeMine, bot, mcData, position, options);
        await this.collectVisibleOres(activeMine, bot, mcData, bot.entity.position.floored(), options);
      }
      await this.gotoPosition(activeMine, bot, nextFeet, 0);
      status.staircaseSteps += 1;
    }

    if (bot.entity.position.floored().y !== status.targetY) {
      throw new StripMiningStopError(
        `Could not reach the requested mineshaft level Y=${status.targetY}.`
      );
    }
    return bot.entity.position.floored();
  }

  private getTunnelSlice(
    center: Vec3,
    direction: DirectionVector,
    tunnelWidth: number,
    tunnelHeight: number
  ): Vec3[] {
    const positions: Vec3[] = [];
    const firstOffset = -Math.floor((tunnelWidth - 1) / 2);
    for (let width = 0; width < tunnelWidth; width += 1) {
      const sideOffset = firstOffset + width;
      for (let height = 0; height < tunnelHeight; height += 1) {
        positions.push(new Vec3(
          center.x + (direction.x === 0 ? sideOffset : 0),
          center.y + height,
          center.z + (direction.z === 0 ? sideOffset : 0)
        ));
      }
    }
    return positions;
  }

  private async mineBlock(
    activeMine: ActiveStripMine,
    bot: mineflayer.Bot,
    mcData: MinecraftData,
    position: Vec3,
    options: MineBlockOptions
  ): Promise<boolean> {
    const { status, abortController } = activeMine;
    this.throwIfAborted(abortController.signal);
    let block = bot.blockAt(position);
    if (!block) {
      throw new StripMiningStopError(`Cannot mine at ${position}; the block is not loaded.`);
    }
    if (AIR_BLOCKS.has(block.name)) {
      return false;
    }
    if (DROP_HAZARDS.has(block.name)) {
      throw new StripMiningStopError(`Stopped before mining into ${block.name} at ${position}.`);
    }
    if (this.hasAdjacentHazard(bot, position)) {
      throw new StripMiningStopError(`Stopped before mining a block beside a fluid or fire hazard at ${position}.`);
    }

    if (!bot.canDigBlock(block) || !bot.canSeeBlock(block)) {
      await this.gotoPosition(activeMine, bot, position, 2);
      block = bot.blockAt(position);
      this.throwIfAborted(abortController.signal);
    }
    if (!block || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') {
      return false;
    }

    const blockData = mcData.blocksByName[block.name];
    if (!blockData?.diggable) {
      throw new StripMiningStopError(`Block '${block.name}' at ${position} cannot be mined.`);
    }
    const isOre = options.oreTypes.has(block.name);
    const isOreBlock = block.name.endsWith('_ore') || block.name === 'ancient_debris';
    let tool: InventoryItem | undefined;
    try {
      tool = findCompatibleMiningTool(
        bot,
        blockData,
        block.name,
        block.name === 'stone' ? 'cobblestone' : undefined,
        isOreBlock
      );
    } catch (error) {
      throw new StripMiningStopError(this.formatError(error));
    }

    if (tool) {
      await bot.equip(tool, 'hand');
    }
    const refreshedBlock = bot.blockAt(position);
    if (!refreshedBlock || refreshedBlock.name !== block.name) {
      return false;
    }
    if (!bot.canDigBlock(refreshedBlock)) {
      throw new StripMiningStopError(`Cannot safely dig '${refreshedBlock.name}' at ${position}.`);
    }
    if (!refreshedBlock.canHarvest(tool?.type ?? null)) {
      throw new StripMiningStopError(
        `The available tool cannot harvest '${refreshedBlock.name}' for its drop at ${position}.`
      );
    }

    await bot.dig(refreshedBlock);
    status.blocksDug += 1;
    if (isOre) {
      status.oreBlocksDug += 1;
      if (!status.message.includes('branch')) {
        status.message = `Harvested exposed '${block.name}' at ${position}.`;
      }
    }
    return true;
  }

  private async collectVisibleOres(
    activeMine: ActiveStripMine,
    bot: mineflayer.Bot,
    mcData: MinecraftData,
    returnPosition: Vec3,
    options: MineBlockOptions
  ): Promise<void> {
    const { status, abortController } = activeMine;
    if (options.oreTypes.size === 0) {
      return;
    }

    const visitedPositions = new Set<string>();
    let branchBlocks = 0;
    let attemptedBranch = false;
    status.message = 'Checking nearby exposed target ores.';
    while (branchBlocks < status.maxOreBlocksPerBranch) {
      this.throwIfAborted(abortController.signal);
      const orePosition = this.findVisibleOre(bot, options.oreTypes, status.branchSearchRadius, visitedPositions);
      if (!orePosition) {
        break;
      }
      attemptedBranch = true;
      visitedPositions.add(orePosition.toString());
      const oreName = bot.blockAt(orePosition)?.name;
      status.message = `Branching to collect exposed '${oreName ?? 'ore'}' at ${orePosition}.`;

      try {
        const mined = await this.mineBlock(activeMine, bot, mcData, orePosition, options);
        if (mined) {
          branchBlocks += 1;
          status.branchOreBlocksDug += 1;
        }
      } catch (error) {
        this.throwIfAborted(abortController.signal);
        status.skippedBlocks += 1;
        log(
          'warn',
          `Strip mining job ${status.jobId}: skipped exposed ore at ${orePosition}: ${this.formatError(error)}`
        );
      }
    }

    if (branchBlocks >= status.maxOreBlocksPerBranch &&
      this.findVisibleOre(bot, options.oreTypes, status.branchSearchRadius, visitedPositions)) {
      status.skippedBlocks += 1;
      log('warn', `Strip mining job ${status.jobId}: reached the ore branch limit.`);
    }

    if (attemptedBranch) {
      await this.gotoPosition(activeMine, bot, returnPosition, 1);
    }
  }

  private findVisibleOre(
    bot: mineflayer.Bot,
    oreTypes: Set<string>,
    radius: number,
    visitedPositions: Set<string>
  ): Vec3 | undefined {
    const center = bot.entity.position.floored();
    const candidates: Vec3[] = [];
    for (let x = -radius; x <= radius; x += 1) {
      for (let y = -radius; y <= radius; y += 1) {
        for (let z = -radius; z <= radius; z += 1) {
          const position = center.offset(x, y, z);
          if (
            Math.hypot(x, y, z) > radius ||
            visitedPositions.has(position.toString()) ||
            this.hasAdjacentHazard(bot, position)
          ) {
            continue;
          }
          const block = bot.blockAt(position);
          if (
            block &&
            oreTypes.has(block.name) &&
            bot.canSeeBlock(block)
          ) {
            candidates.push(position);
          }
        }
      }
    }

    candidates.sort((first, second) =>
      this.distanceBetween(first, center) - this.distanceBetween(second, center)
    );
    return candidates[0];
  }

  private hasAdjacentHazard(bot: mineflayer.Bot, position: Vec3): boolean {
    return [
      position,
      position.offset(0, 1, 0),
      position.offset(0, -1, 0),
      position.offset(1, 0, 0),
      position.offset(-1, 0, 0),
      position.offset(0, 0, 1),
      position.offset(0, 0, -1)
    ].some(adjacent => {
      const block = bot.blockAt(adjacent);
      return block ? DROP_HAZARDS.has(block.name) : false;
    });
  }

  private async placeTorchBehind(
    activeMine: ActiveStripMine,
    bot: mineflayer.Bot,
    torchPosition: Vec3
  ): Promise<void> {
    const { status } = activeMine;
    const torch = bot.inventory.items().find(item => item.name === 'torch');
    if (!torch) {
      status.message = 'No torches remain in inventory; continuing without placing more.';
      return;
    }

    const targetBlock = bot.blockAt(torchPosition);
    const floorBlock = bot.blockAt(torchPosition.offset(0, -1, 0));
    if (
      !targetBlock ||
      !AIR_BLOCKS.has(targetBlock.name) ||
      !floorBlock ||
      AIR_BLOCKS.has(floorBlock.name) ||
      DROP_HAZARDS.has(floorBlock.name)
    ) {
      return;
    }

    try {
      await bot.equip(torch, 'hand');
      await bot.lookAt(torchPosition, true);
      await bot.placeBlock(floorBlock, new Vec3(0, 1, 0));
      const placedBlock = bot.blockAt(torchPosition);
      if (placedBlock?.name.includes('torch')) {
        status.torchesPlaced += 1;
      }
    } catch (error) {
      status.skippedBlocks += 1;
      log(
        'warn',
        `Strip mining job ${status.jobId}: could not place a torch at ${torchPosition}: ${this.formatError(error)}`
      );
    }
  }

  private async gotoPosition(
    activeMine: ActiveStripMine,
    bot: mineflayer.Bot,
    position: Vec3,
    range: number
  ): Promise<void> {
    const signal = activeMine.abortController.signal;
    this.throwIfAborted(signal);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([
        bot.pathfinder.goto(new goals.GoalNear(position.x, position.y, position.z, range)),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new StripMiningStopError(`Timed out navigating to ${position}.`)),
            PATHFINDING_TIMEOUT_MS
          );
        }),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new Error('Strip mining was cancelled.'));
          signal.addEventListener('abort', onAbort, { once: true });
        })
      ]);
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      if (error instanceof StripMiningStopError) {
        this.stopBotActivity(bot, activeMine.status.jobId, true);
        throw error;
      }
      throw new StripMiningStopError(`Could not navigate to ${position}: ${this.formatError(error)}`);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
    this.throwIfAborted(signal);
  }

  private distanceBetween(first: Vec3, second: Vec3): number {
    return Math.hypot(first.x - second.x, first.y - second.y, first.z - second.z);
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new Error('Strip mining was cancelled.');
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
        log('warn', `Could not stop ${name} for strip mining job ${jobId}: ${this.formatError(error)}`);
      }
    }
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
