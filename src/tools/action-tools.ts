import { z } from 'zod';
import mineflayer from 'mineflayer';
import { BlockCollectionArea, BlockCollectionRunner } from '../actions/block-collection.js';
import { ToolFactory } from '../tool-factory.js';

const coordinateSchema = z.coerce.number().int().min(-30_000_000).max(30_000_000);
const targetCountSchema = z.coerce.number().int().min(1).max(2_304);
const harvestBatchSizeSchema = z.coerce.number().int().min(1).max(64).default(8);
const collectionWindowSecondsSchema = z.coerce.number().min(1).max(30).default(5);
const actionControlOptions = { allowDuringExclusiveOperation: true };

export function registerActionTools(factory: ToolFactory, getBot: () => mineflayer.Bot): BlockCollectionRunner {
  const blockCollection = new BlockCollectionRunner(factory, getBot);

  factory.registerTool(
    'collect-blocks',
    'Collect a target number of items from one exact Minecraft block type in a bounded area. Harvests in configurable batches, then makes a bounded pass for nearby drops; inaccessible or lost drops do not stop harvesting. Supports selected dirt, sand, stone, deepslate, and vanilla wood blocks.',
    {
      blockType: z.string().trim().min(1).describe("Exact Minecraft block name, such as 'dirt', 'stone', or 'oak_log'"),
      targetCount: targetCountSchema.describe('Number of drop items to collect (1-2304)'),
      minX: coordinateSchema.describe('Minimum X coordinate of the mining area'),
      maxX: coordinateSchema.describe('Maximum X coordinate of the mining area'),
      minY: coordinateSchema.describe('Minimum Y coordinate of the mining area'),
      maxY: coordinateSchema.describe('Maximum Y coordinate of the mining area'),
      minZ: coordinateSchema.describe('Minimum Z coordinate of the mining area'),
      maxZ: coordinateSchema.describe('Maximum Z coordinate of the mining area'),
      harvestBatchSize: harvestBatchSizeSchema.describe(
        'Blocks to harvest before switching to item collection (1-64, default 8)'
      ),
      collectionWindowSeconds: collectionWindowSecondsSchema.describe(
        'Maximum time to look for and collect nearby drops after each harvest batch (1-30 seconds, default 5)'
      )
    },
    async ({
      blockType,
      targetCount,
      minX,
      maxX,
      minY,
      maxY,
      minZ,
      maxZ,
      harvestBatchSize,
      collectionWindowSeconds
    }: {
      blockType: string;
      targetCount: number;
      minX: number;
      maxX: number;
      minY: number;
      maxY: number;
      minZ: number;
      maxZ: number;
      harvestBatchSize: number;
      collectionWindowSeconds: number;
    }) => {
      const area: BlockCollectionArea = { minX, maxX, minY, maxY, minZ, maxZ };
      const status = blockCollection.start(blockType, targetCount, area, {
        harvestBatchSize,
        collectionWindowSeconds
      });
      return factory.createResponse(
        `Started block collection job ${status.jobId}: collecting ${targetCount} ${status.dropItem} item(s) ` +
        `from '${status.blockType}' blocks, harvesting up to ${status.harvestBatchSize} block(s) between ` +
        `collection passes. Use get-block-collection-status to check progress or ` +
        'stop-block-collection to cancel.'
      );
    },
    actionControlOptions
  );

  factory.registerTool(
    'collect-dirt',
    'Legacy dirt-only alias. Collect a target number of dirt items from the specified bounded area.',
    {
      targetCount: targetCountSchema.describe('Number of dirt items to collect (1-2304)'),
      minX: coordinateSchema.describe('Minimum X coordinate of the mining area'),
      maxX: coordinateSchema.describe('Maximum X coordinate of the mining area'),
      minY: coordinateSchema.describe('Minimum Y coordinate of the mining area'),
      maxY: coordinateSchema.describe('Maximum Y coordinate of the mining area'),
      minZ: coordinateSchema.describe('Minimum Z coordinate of the mining area'),
      maxZ: coordinateSchema.describe('Maximum Z coordinate of the mining area')
    },
    async ({ targetCount, minX, maxX, minY, maxY, minZ, maxZ }: {
      targetCount: number;
      minX: number;
      maxX: number;
      minY: number;
      maxY: number;
      minZ: number;
      maxZ: number;
    }) => {
      const area: BlockCollectionArea = { minX, maxX, minY, maxY, minZ, maxZ };
      const status = blockCollection.start('dirt', targetCount, area);
      return factory.createResponse(
        `Started dirt collection job ${status.jobId} for ${targetCount} additional dirt items. ` +
        'Use get-dirt-collection-status to check progress or stop-dirt-collection to cancel.'
      );
    },
    actionControlOptions
  );

  const getStatusResponse = (blockType?: string) => {
    const status = blockCollection.getStatus();
    if (!status || (blockType && status.blockType !== blockType)) {
      return factory.createResponse(
        blockType
          ? `No ${blockType} collection job has been started.`
          : 'No block collection job has been started.'
      );
    }
    return factory.createResponse(JSON.stringify(status, null, 2));
  };

  factory.registerTool(
    'get-block-collection-status',
    'Get the current or most recent generic block collection job status.',
    {},
    async () => getStatusResponse(),
    actionControlOptions
  );

  factory.registerTool(
    'stop-block-collection',
    'Stop the active block collection job and release the bot for other tools.',
    {},
    async () => factory.createResponse(blockCollection.stop()),
    actionControlOptions
  );

  factory.registerTool(
    'get-dirt-collection-status',
    'Legacy dirt-only alias for checking dirt collection status.',
    {},
    async () => getStatusResponse('dirt'),
    actionControlOptions
  );

  factory.registerTool(
    'stop-dirt-collection',
    'Legacy dirt-only alias for stopping an active dirt collection job.',
    {},
    async () => {
      const status = blockCollection.getStatus();
      if (status?.state === 'running' && status.blockType !== 'dirt') {
        return factory.createResponse(
          `A '${status.blockType}' collection job is active. Use stop-block-collection to cancel it.`
        );
      }
      return factory.createResponse(blockCollection.stop());
    },
    actionControlOptions
  );

  return blockCollection;
}
