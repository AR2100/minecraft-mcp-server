import test from 'ava';
import sinon from 'sinon';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import { DirtCollectionRunner, DirtCollectionArea } from '../src/actions/dirt-collection.js';
import { ToolFactory } from '../src/tool-factory.js';
import type { BotConnection } from '../src/bot-connection.js';

const area: DirtCollectionArea = {
  minX: 1,
  maxX: 2,
  minY: 63,
  maxY: 63,
  minZ: 0,
  maxZ: 0
};

function createBot(dirtPositions: Vec3[], occupiedInventory = false, pickupDelayMs = 0): {
  bot: mineflayer.Bot;
  dugPositions: Vec3[];
} {
  const blocks = new Map<string, { name: string; position: Vec3 }>();
  for (const position of dirtPositions) {
    blocks.set(position.toString(), { name: 'dirt', position });
  }

  const shovel = { name: 'stone_shovel', count: 1, slot: 36 };
  const inventorySlots = Array(45).fill(null);
  if (occupiedInventory) {
    for (let slot = 9; slot <= 44; slot += 1) {
      inventorySlots[slot] = { name: 'cobblestone', count: 64, slot };
    }
  }
  inventorySlots[36] = shovel;

  let dirtCount = 0;
  const inventory = {
    slots: inventorySlots,
    items: () => [
      shovel,
      ...(dirtCount > 0 ? [{ name: 'dirt', count: dirtCount, slot: 9 }] : [])
    ]
  };
  const dugPositions: Vec3[] = [];
  const bot = {
    version: '1.21.11',
    entity: { position: new Vec3(0.5, 65, 0.5) },
    inventory,
    blockAt: (position: Vec3) => blocks.get(position.toString()) ?? { name: 'air', position },
    canDigBlock: () => true,
    canSeeBlock: () => true,
    dig: async (block: { position: Vec3 }) => {
      dugPositions.push(block.position);
      blocks.delete(block.position.toString());
      if (pickupDelayMs > 0) {
        setTimeout(() => {
          dirtCount += 1;
        }, pickupDelayMs);
      } else {
        dirtCount += 1;
      }
    },
    equip: sinon.stub().resolves(),
    pathfinder: {
      goto: sinon.stub().resolves(),
      stop: sinon.stub()
    },
    stopDigging: sinon.stub(),
    clearControlStates: sinon.stub()
  } as unknown as mineflayer.Bot;

  return { bot, dugPositions };
}

function createRunner(bot: mineflayer.Bot): DirtCollectionRunner {
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const connection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  return new DirtCollectionRunner(new ToolFactory(server, connection), () => bot);
}

async function waitForJobToFinish(runner: DirtCollectionRunner, timeoutMs = 2_000): Promise<void> {
  for (let attempt = 0; attempt < timeoutMs / 10; attempt += 1) {
    if (runner.getStatus()?.state !== 'running') {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('collects the target amount and only digs dirt inside the supplied area', async (t) => {
  const insidePositions = [new Vec3(1, 63, 0), new Vec3(2, 63, 0)];
  const outsidePosition = new Vec3(3, 63, 0);
  const { bot, dugPositions } = createBot([...insidePositions, outsidePosition]);
  const runner = createRunner(bot);

  const started = runner.start(2, area);
  await waitForJobToFinish(runner);

  const status = runner.getStatus();
  t.is(status?.jobId, started.jobId);
  t.is(status?.state, 'completed');
  t.is(status?.collectedCount, 2);
  t.is(status?.blocksDug, 2);
  t.is(dugPositions.length, 2);
  t.true(dugPositions.every(position => position.x >= area.minX && position.x <= area.maxX));
});

test('waits for a delayed dirt pickup before marking the job incomplete', async (t) => {
  const { bot, dugPositions } = createBot([new Vec3(1, 63, 0)], false, 2_500);
  const runner = createRunner(bot);

  runner.start(1, area);
  await waitForJobToFinish(runner, 6_000);

  const status = runner.getStatus();
  t.is(status?.state, 'completed');
  t.is(status?.collectedCount, 1);
  t.is(status?.blocksDug, 1);
  t.is(dugPositions.length, 1);
});

test('rejects collection requests larger than available inventory space', (t) => {
  const { bot } = createBot([new Vec3(1, 63, 0)], true);
  const runner = createRunner(bot);

  const error = t.throws(() => runner.start(1, area));

  t.truthy(error?.message.includes('hold only 0 additional dirt blocks'));
  t.is(runner.getStatus(), null);
});

test('rejects an area that exceeds the bounded scan volume', (t) => {
  const { bot } = createBot([]);
  const runner = createRunner(bot);

  const error = t.throws(() => runner.start(1, {
    minX: 0,
    maxX: 255,
    minY: 0,
    maxY: 255,
    minZ: 0,
    maxZ: 255
  }));

  t.truthy(error?.message.includes('cannot exceed'));
  t.is(runner.getStatus(), null);
});
