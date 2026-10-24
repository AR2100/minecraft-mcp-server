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
  deferPickup?: boolean;
  additionalBlockCount?: number;
  dropYOffset?: number;
  hazardousDrop?: boolean;
  pickupFails?: boolean;
  breakToolAfterDigs?: number;
  replacementToolName?: string;
  canHarvest?: boolean;
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
  let replacementTool: InventoryStack | undefined;
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
  if (options.replacementToolName) {
    const replacementData = mcData.itemsByName[options.replacementToolName];
    if (!replacementData) {
      throw new Error(`Test fixture data missing for ${options.replacementToolName}.`);
    }
    replacementTool = {
      name: options.replacementToolName,
      type: replacementData.id,
      count: 1,
      slot: 37,
      enchants: []
    };
    slots[37] = replacementTool;
  }

  let collectedCount = 0;
  let digCount = 0;
  let heldItem: InventoryStack | null = null;
  const position = new Vec3(1, 64, 1);
  const blocks = new Map<string, {
    name: string;
    type: number;
    position: Vec3;
    canHarvest: () => boolean;
  }>();
  const blockCount = 1 + (options.additionalBlockCount ?? 0);
  for (let index = 0; index < blockCount; index += 1) {
    const blockPosition = position.offset(-index, 0, 0);
    blocks.set(blockPosition.toString(), {
      name: blockType,
      type: blockData.id,
      position: blockPosition,
      canHarvest: sinon.stub().returns(options.canHarvest ?? true)
    });
  }
  const entities: Record<number, {
    id: number;
    isValid: boolean;
    position: Vec3;
    getDroppedItem: () => { name: string };
  }> = {};
  const dugPositions: Vec3[] = [];
  let nextEntityId = 1;
  let dugCountAtFirstPickup: number | undefined;

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
    entities,
    entity: { position: new Vec3(0, 64, 0) },
    blockAt: (target: Vec3) => {
      const block = blocks.get(target.toString());
      if (block) return block;
      if (
        options.hazardousDrop &&
        Object.values(entities).some(entity => entity.position.equals(target))
      ) {
        return { name: 'fire', position: target };
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
    get heldItem() {
      return heldItem;
    },
    equip: sinon.stub().callsFake(async (item: InventoryStack) => {
      heldItem = item;
    }),
    dig: sinon.stub().callsFake(async (targetBlock: { position: Vec3 }) => {
      blocks.delete(targetBlock.position.toString());
      dugPositions.push(targetBlock.position);
      digCount += 1;
      if (options.breakToolAfterDigs === digCount) {
        slots[tool.slot] = null;
        heldItem = null;
      }
      if (options.delayedPickupMs) {
        setTimeout(() => {
          collectedCount += 1;
        }, options.delayedPickupMs);
      } else if (options.deferPickup) {
        const drop = {
          id: nextEntityId++,
          isValid: true,
          position: targetBlock.position.offset(0, options.dropYOffset ?? 0, 0),
          getDroppedItem: () => ({ name: dropItem })
        };
        entities[drop.id] = drop;
      } else {
        collectedCount += 1;
      }
    }),
    clearControlStates: sinon.stub(),
    stopDigging: sinon.stub(),
    pathfinder: {
      goto: sinon.stub().callsFake(async () => {
        if (options.pickupFails && Object.keys(entities).length > 0) {
          throw new Error('The drop cannot be reached.');
        }
        const drop = Object.values(entities).find(entity => entity.isValid);
        if (drop) {
          dugCountAtFirstPickup ??= dugPositions.length;
          collectedCount += 1;
          drop.isValid = false;
          delete entities[drop.id];
        }
      }),
      stop: sinon.stub()
    }
  };

  return {
    bot: bot as unknown as mineflayer.Bot,
    block: blocks.get(position.toString()),
    tool,
    replacementTool,
    dugPositions,
    get dugCountAtFirstPickup() {
      return dugCountAtFirstPickup;
    }
  };
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

  const calls = (server.tool as sinon.SinonStub).getCalls();
  const names = calls.map(call => call.args[0]);
  const collectBlocksCall = calls.find(call => call.args[0] === 'collect-blocks');
  t.truthy(collectBlocksCall);
  t.true('harvestBatchSize' in (collectBlocksCall!.args[2] as Record<string, unknown>));
  t.true('collectionWindowSeconds' in (collectBlocksCall!.args[2] as Record<string, unknown>));
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

test('switches to a compatible replacement tool after the current tool breaks', async t => {
  const fixture = createBot(
    'stone',
    'stone_pickaxe',
    'cobblestone',
    {
      additionalBlockCount: 1,
      breakToolAfterDigs: 1,
      replacementToolName: 'stone_pickaxe'
    }
  );
  const runner = createRunner(fixture.bot);

  runner.start('stone', 2, area, { harvestBatchSize: 2, collectionWindowSeconds: 1 });
  const status = await waitForTerminalStatus(runner);
  const equipCalls = (fixture.bot.equip as sinon.SinonStub).getCalls();

  t.is(status.state, 'completed');
  t.is(status.blocksDug, 2);
  t.is(status.collectedCount, 2);
  t.truthy(fixture.replacementTool);
  t.true(equipCalls.some(call => (call.args[0] as InventoryStack).slot === 37));
});

test('stops harvesting when the tool breaks and no compatible replacement remains', async t => {
  const fixture = createBot(
    'stone',
    'stone_pickaxe',
    'cobblestone',
    { additionalBlockCount: 1, breakToolAfterDigs: 1 }
  );
  const runner = createRunner(fixture.bot);

  runner.start('stone', 2, area, { harvestBatchSize: 2, collectionWindowSeconds: 1 });
  const status = await waitForTerminalStatus(runner);

  t.is(status.state, 'incomplete');
  t.is(status.blocksDug, 1);
  t.is(status.collectedCount, 1);
  t.true(status.message.includes('no suitable harvesting tool is available'));
  t.is((fixture.bot.dig as sinon.SinonStub).callCount, 1);
});

test('stops harvesting when the available tool cannot harvest the block for its drop', async t => {
  const { bot } = createBot('stone', 'stone_pickaxe', 'cobblestone', { canHarvest: false });
  const runner = createRunner(bot);

  runner.start('stone', 1, area);
  const status = await waitForTerminalStatus(runner);

  t.is(status.state, 'incomplete');
  t.is(status.blocksDug, 0);
  t.true(status.message.includes('cannot harvest this block for its drop'));
  t.is((bot.dig as sinon.SinonStub).callCount, 0);
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

test('harvests the configured batch before attempting nearby drop pickup', async t => {
  const fixture = createBot(
    'oak_log',
    'stone_axe',
    'oak_log',
    { deferPickup: true, additionalBlockCount: 2 }
  );
  const { bot } = fixture;
  const runner = createRunner(bot);

  runner.start('oak_log', 1, area, {
    harvestBatchSize: 2,
    collectionWindowSeconds: 1
  });
  const status = await waitForTerminalStatus(runner);

  t.is(status.state, 'completed');
  t.is(status.blocksDug, 2);
  t.is(status.collectedCount, 1);
  t.is(status.harvestBatchSize, 2);
  t.is(status.collectionWindowSeconds, 1);
  t.is(fixture.dugCountAtFirstPickup, 2);
});

test('continues harvesting when drops fall too far below the collection area', async t => {
  const { bot } = createBot(
    'oak_log',
    'stone_axe',
    'oak_log',
    { deferPickup: true, additionalBlockCount: 1, dropYOffset: -12 }
  );
  const runner = createRunner(bot);

  runner.start('oak_log', 2, area, {
    harvestBatchSize: 1,
    collectionWindowSeconds: 1
  });
  const status = await waitForTerminalStatus(runner, 5_000);

  t.is(status.state, 'incomplete');
  t.is(status.blocksDug, 2);
  t.is(status.collectedCount, 0);
});

test('does not pursue drops in fire and continues harvesting', async t => {
  const { bot } = createBot(
    'oak_log',
    'stone_axe',
    'oak_log',
    { deferPickup: true, additionalBlockCount: 1, hazardousDrop: true }
  );
  const runner = createRunner(bot);

  runner.start('oak_log', 2, area, {
    harvestBatchSize: 2,
    collectionWindowSeconds: 1
  });
  const status = await waitForTerminalStatus(runner);

  t.is(status.state, 'incomplete');
  t.is(status.blocksDug, 2);
  t.is(status.collectedCount, 0);
  t.is((bot.pathfinder.goto as sinon.SinonStub).callCount, 0);
});

test('continues harvesting after an unreachable nearby drop', async t => {
  const { bot } = createBot(
    'oak_log',
    'stone_axe',
    'oak_log',
    { deferPickup: true, additionalBlockCount: 1, pickupFails: true }
  );
  const runner = createRunner(bot);

  runner.start('oak_log', 2, area, {
    harvestBatchSize: 1,
    collectionWindowSeconds: 1
  });
  const status = await waitForTerminalStatus(runner);

  t.is(status.state, 'incomplete');
  t.is(status.blocksDug, 2);
  t.is(status.collectedCount, 0);
  t.is(status.skippedDrops, 2);
});

test('rejects invalid harvest and collection cadence settings', t => {
  const { bot } = createBot('dirt', 'stone_shovel', 'dirt');
  const runner = createRunner(bot);

  const batchError = t.throws(() => runner.start('dirt', 1, area, { harvestBatchSize: 65 }));
  const windowError = t.throws(() =>
    runner.start('dirt', 1, area, { collectionWindowSeconds: 0 })
  );

  t.truthy(batchError?.message.includes('harvestBatchSize'));
  t.truthy(windowError?.message.includes('collectionWindowSeconds'));
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
