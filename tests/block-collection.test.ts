import test from 'ava';
import minecraftData from 'minecraft-data';
import mineflayer from 'mineflayer';
import sinon from 'sinon';
import { Vec3 } from 'vec3';
import {
  BlockCollectionArea,
  BlockCollectionRunner,
  BlockCollectionStatus
} from '../src/actions/block-collection.js';
import { DirtCollectionRunner } from '../src/actions/dirt-collection.js';
import { registerActionTools } from '../src/tools/action-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';

const area: BlockCollectionArea = {
  minX: -2,
  maxX: 2,
  minY: 62,
  maxY: 66,
  minZ: -2,
  maxZ: 2
};

interface InventoryStack {
  name: string;
  type: number;
  count: number;
  slot: number;
  enchants: Array<{ name: string; lvl: number }>;
}

interface BotOptions {
  occupiedItem?: string;
  delayedPickupMs?: number;
  silkTouch?: boolean;
}

function createBot(blockType: string, toolName: string, dropItem: string, options: BotOptions = {}) {
  const mcData = minecraftData('1.21.8');
  const blockData = mcData.blocksByName[blockType];
  const toolData = mcData.itemsByName[toolName];
  const dropData = mcData.itemsByName[dropItem];
  if (!blockData || !toolData || !dropData) {
    throw new Error(`Test fixture data missing for ${blockType}, ${toolName}, or ${dropItem}.`);
  }

  const tool: InventoryStack = {
    name: toolName,
    type: toolData.id,
    count: 1,
    slot: 36,
    enchants: options.silkTouch ? [{ name: 'silk_touch', lvl: 1 }] : []
  };
  const slots: Array<InventoryStack | null> = Array(45).fill(null);
  if (options.occupiedItem) {
    const occupiedData = mcData.itemsByName[options.occupiedItem];
    if (!occupiedData) {
      throw new Error(`Test fixture data missing for ${options.occupiedItem}.`);
    }
    for (let slot = 9; slot <= 44; slot += 1) {
      slots[slot] = {
        name: options.occupiedItem,
        type: occupiedData.id,
        count: 64,
        slot,
        enchants: []
      };
    }
  }
  slots[36] = tool;

  let collectedCount = 0;
  const position = new Vec3(1, 64, 1);
  const block = {
    name: blockType,
    type: blockData.id,
    position,
    canHarvest: sinon.stub().returns(true)
  };
  let blockAvailable = true;

  const inventory = {
    slots,
    items: () => {
      const items = slots.slice(9).filter((item): item is InventoryStack => item !== null)
        .map(item => ({ ...item, enchants: [...item.enchants] }));
      if (collectedCount > 0) {
        const stack = items.find(item => item.name === dropItem);
        if (stack) {
          stack.count += collectedCount;
        } else {
          items.push({
            name: dropItem,
            type: dropData.id,
            count: collectedCount,
            slot: 9,
            enchants: []
          });
        }
      }
      return items;
    }
  };

  const bot = {
    version: '1.21.8',
    inventory,
    entity: { position: new Vec3(0, 64, 0) },
    blockAt: (target: Vec3) => {
      if (blockAvailable && target.equals(position)) {
        return block;
      }
      return {
        name: 'air',
        type: mcData.blocksByName.air.id,
        position: target,
        canHarvest: () => false
      };
    },
    canDigBlock: () => true,
    canSeeBlock: () => true,
    equip: sinon.stub().resolves(),
    dig: sinon.stub().callsFake(async () => {
      blockAvailable = false;
      if (options.delayedPickupMs) {
        await new Promise<void>(resolve => {
          setTimeout(() => {
            collectedCount += 1;
            resolve();
          }, options.delayedPickupMs);
        });
      } else {
        collectedCount += 1;
      }
    }),
    clearControlStates: sinon.stub(),
    stopDigging: sinon.stub(),
    pathfinder: {
      goto: sinon.stub().resolves(),
      stop: sinon.stub()
    }
  };

  return { bot: bot as unknown as mineflayer.Bot, block, tool };
}

function createRunner(bot: mineflayer.Bot) {
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const connection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(server, connection);
  return new BlockCollectionRunner(factory, () => bot);
}

async function waitForTerminalStatus(
  runner: { getStatus: () => BlockCollectionStatus | null },
  timeoutMs = 5_000
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = runner.getStatus();
    if (status && status.state !== 'running') {
      return status;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Block collection did not reach a terminal state before the test timeout.');
}

test('block collection registers generic and legacy tools', t => {
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const connection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(server, connection);

  registerActionTools(factory, () => ({} as mineflayer.Bot));

  const names = (server.tool as sinon.SinonStub).getCalls().map(call => call.args[0]);
  t.true(names.includes('collect-blocks'));
  t.true(names.includes('get-block-collection-status'));
  t.true(names.includes('stop-block-collection'));
  t.true(names.includes('collect-dirt'));
  t.true(names.includes('get-dirt-collection-status'));
  t.true(names.includes('stop-dirt-collection'));
});

test('collects dirt and reports the generic drop status', async t => {
  const { bot } = createBot('dirt', 'stone_shovel', 'dirt');
  const runner = createRunner(bot);

  const started = runner.start('dirt', 1, area);
  const status = await waitForTerminalStatus(runner);

  t.is(started.blockType, 'dirt');
  t.is(started.dropItem, 'dirt');
  t.is(status.state, 'completed');
  t.is(status.collectedCount, 1);
  t.is(status.blocksDug, 1);
});

test('collects stone drops with a pickaxe and targets cobblestone', async t => {
  const { bot, tool } = createBot('stone', 'stone_pickaxe', 'cobblestone');
  const runner = createRunner(bot);

  const started = runner.start('stone', 1, area);
  const status = await waitForTerminalStatus(runner);

  t.is(started.dropItem, 'cobblestone');
  t.is(status.state, 'completed');
  t.true((bot.equip as sinon.SinonStub).calledWith(tool, 'hand'));
});

test('collects deepslate drops as cobbled deepslate', async t => {
  const { bot } = createBot('deepslate', 'stone_pickaxe', 'cobbled_deepslate');
  const runner = createRunner(bot);

  const started = runner.start('deepslate', 1, area);
  const status = await waitForTerminalStatus(runner);

  t.is(started.dropItem, 'cobbled_deepslate');
  t.is(status.state, 'completed');
});

test('collects oak logs with an axe', async t => {
  const { bot, tool } = createBot('oak_log', 'stone_axe', 'oak_log');
  const runner = createRunner(bot);

  runner.start('oak_log', 1, area);
  const status = await waitForTerminalStatus(runner);

  t.is(status.state, 'completed');
  t.true((bot.equip as sinon.SinonStub).calledWith(tool, 'hand'));
});

test('preserves the dirt runner API as a compatibility wrapper', async t => {
  const { bot } = createBot('dirt', 'stone_shovel', 'dirt');
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const connection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const runner = new DirtCollectionRunner(new ToolFactory(server, connection), () => bot);

  const started = runner.start(1, area);
  const status = await waitForTerminalStatus(runner);

  t.is(started.blockType, 'dirt');
  t.is(status.state, 'completed');
});

test('allows delayed pickup within the confirmation window', async t => {
  const { bot } = createBot('dirt', 'stone_shovel', 'dirt', { delayedPickupMs: 2_500 });
  const runner = createRunner(bot);

  runner.start('dirt', 1, area);
  const status = await waitForTerminalStatus(runner, 8_000);

  t.is(status.state, 'completed');
  t.is(status.collectedCount, 1);
});

test('rejects ambiguous self-drops even when metadata lists one item', t => {
  const { bot } = createBot('dirt', 'stone_shovel', 'dirt');
  const runner = createRunner(bot);

  const error = t.throws(() => runner.start('gravel', 1, area));

  t.truthy(error);
  t.true(error.message.includes("not in the collector's supported predictable-drop set"));
});

test('rejects blocks with no drop data', t => {
  const { bot } = createBot('dirt', 'stone_shovel', 'dirt');
  const runner = createRunner(bot);

  const error = t.throws(() => runner.start('glass', 1, area));

  t.truthy(error);
  t.true(error.message.includes('single predictable drop'));
});

test('rejects a block when no compatible mining tool is available', t => {
  const { bot } = createBot('stone', 'stone_shovel', 'cobblestone');
  const runner = createRunner(bot);

  const error = t.throws(() => runner.start('stone', 1, area));

  t.truthy(error);
  t.true(error.message.includes('compatible pickaxe'));
});

test('rejects collection when the required drop has no inventory capacity', t => {
  const { bot } = createBot('dirt', 'stone_shovel', 'dirt', { occupiedItem: 'dirt' });
  const runner = createRunner(bot);

  const error = t.throws(() => runner.start('dirt', 1, area));

  t.truthy(error);
  t.true(error.message.includes('hold only 0 additional dirt'));
});

test('rejects a Silk Touch tool when it could change the expected drop', t => {
  const { bot } = createBot('stone', 'stone_pickaxe', 'cobblestone', { silkTouch: true });
  const runner = createRunner(bot);

  const error = t.throws(() => runner.start('stone', 1, area));

  t.truthy(error);
  t.true(error.message.includes('Silk Touch'));
});

test('releases exclusive operation when a collection finishes', async t => {
  const { bot } = createBot('dirt', 'stone_shovel', 'dirt');
  const runner = createRunner(bot);
  runner.start('dirt', 1, area);

  const firstStatus = await waitForTerminalStatus(runner);
  runner.start('dirt', 1, area);
  const secondStatus = await waitForTerminalStatus(runner);

  t.is(firstStatus.state, 'completed');
  t.is(secondStatus.state, 'incomplete');
});
