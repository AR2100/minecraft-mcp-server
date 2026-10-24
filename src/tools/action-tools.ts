import { z } from 'zod';
import mineflayer from 'mineflayer';
import { DirtCollectionArea, DirtCollectionRunner } from '../actions/dirt-collection.js';
import { ToolFactory } from '../tool-factory.js';

const coordinateSchema = z.coerce.number().int().min(-30_000_000).max(30_000_000);
const actionControlOptions = { allowDuringExclusiveOperation: true };

export function registerActionTools(factory: ToolFactory, getBot: () => mineflayer.Bot): DirtCollectionRunner {
  const dirtCollection = new DirtCollectionRunner(factory, getBot);

  factory.registerTool(
    'collect-dirt',
    'Collect an additional target number of dirt blocks from the specified bounded area. The bot needs a shovel and enough free inventory space.',
    {
      targetCount: z.coerce.number().int().min(1).max(2_304).describe('Number of additional dirt blocks to collect (1-2304)'),
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
      const area: DirtCollectionArea = { minX, maxX, minY, maxY, minZ, maxZ };
      const status = dirtCollection.start(targetCount, area);
      return factory.createResponse(
        `Started dirt collection job ${status.jobId} for ${targetCount} additional dirt blocks. ` +
        'Use get-dirt-collection-status to check progress or stop-dirt-collection to cancel.'
      );
    },
    actionControlOptions
  );

  factory.registerTool(
    'get-dirt-collection-status',
    'Get the current or most recent dirt collection job status, including its progress and result.',
    {},
    async () => {
      const status = dirtCollection.getStatus();
      return factory.createResponse(
        status ? JSON.stringify(status, null, 2) : 'No dirt collection job has been started.'
      );
    },
    actionControlOptions
  );

  factory.registerTool(
    'stop-dirt-collection',
    'Stop the active dirt collection job and release the bot for other tools.',
    {},
    async () => factory.createResponse(dirtCollection.stop()),
    actionControlOptions
  );

  return dirtCollection;
}
