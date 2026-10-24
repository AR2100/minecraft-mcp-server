import { z } from 'zod';
import mineflayer from 'mineflayer';
import { StripMiningRunner } from '../actions/strip-mining.js';
import type { StripMiningOptions } from '../actions/strip-mining.js';
import { ToolFactory } from '../tool-factory.js';

const actionControlOptions = { allowDuringExclusiveOperation: true };
const directionSchema = z.enum(['north', 'south', 'east', 'west']).optional();
const stripMiningOptionsSchema = {
  length: z.coerce.number().int().min(1).max(128).default(32),
  targetY: z.coerce.number().int().min(-64).max(320).optional(),
  direction: directionSchema,
  tunnelWidth: z.coerce.number().int().min(1).max(5).default(1),
  tunnelHeight: z.coerce.number().int().min(2).max(5).default(2),
  branchOreTypes: z.array(z.string().trim().min(1)).max(32).optional(),
  branchSearchRadius: z.coerce.number().int().min(1).max(8).default(4),
  maxOreBlocksPerBranch: z.coerce.number().int().min(1).max(128).default(32),
  placeTorches: z.coerce.boolean().default(true),
  torchSpacing: z.coerce.number().int().min(1).max(64).default(8)
};

export function registerStripMiningTools(
  factory: ToolFactory,
  getBot: () => mineflayer.Bot
): StripMiningRunner {
  const runner = new StripMiningRunner(factory, getBot);

  factory.registerTool(
    'strip-mine',
    'Create a bounded straight mineshaft. Descends to targetY if needed, mines the requested tunnel size, branches to nearby visible configured ores, switches to compatible tools per block, and optionally places torches.',
    stripMiningOptionsSchema,
    async (options: StripMiningOptions) => {
      const status = runner.start(options);
      return factory.createResponse(
        `Started strip mining job ${status.jobId}: ${status.length} step(s) toward ${status.direction} ` +
        `at Y=${status.targetY}, with a ${status.tunnelWidth}x${status.tunnelHeight} tunnel. ` +
        'Use get-strip-mining-status to check progress or stop-strip-mining to cancel.'
      );
    },
    actionControlOptions
  );

  factory.registerTool(
    'get-strip-mining-status',
    'Get the current or most recent strip mining job status.',
    {},
    async () => {
      const status = runner.getStatus();
      return factory.createResponse(
        status ? JSON.stringify(status, null, 2) : 'No strip mining job has been started.'
      );
    },
    actionControlOptions
  );

  factory.registerTool(
    'stop-strip-mining',
    'Stop the active strip mining job and release the bot for other tools.',
    {},
    async () => factory.createResponse(runner.stop()),
    actionControlOptions
  );

  return runner;
}
