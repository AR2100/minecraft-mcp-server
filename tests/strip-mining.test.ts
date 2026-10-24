import test from 'ava';
import minecraftData from 'minecraft-data';
import mineflayer from 'mineflayer';
import sinon from 'sinon';
import { Vec3 } from 'vec3';
import { StripMiningOptions, StripMiningRunner, StripMiningStatus } from '../src/actions/strip-mining.js';
import { registerStripMiningTools } from '../src/tools/strip-mining-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';

interface TestBlock {
  name: string;
  type: number;
  position: Vec3;
  canHarvest: () => boolean;
}

interface TestItem {
  name: string;
  type: number;
  count: number;
  slot: number;
  enchants: Array<{ name: string; lvl: number }>;
}

function createBot(startPosition = new Vec3(0, 64, 0)) {
  const mcData = minecraftData('1.21.8');
  const blocks = new Map<string, TestBlock>();
  const pickaxeData = mcData.itemsByName.stone_pickaxe;
  const torchData = mcData.itemsByName.torch;
  const pickaxe: TestItem = {
    name: 'stone_pickaxe',
    type: pickaxeData.id,
    count: 1,
    slot: 36,
    enchants: []
  };
  const torch: TestItem = {
    name: 'torch',
    type: torchData.id,
    count: 16,
    slot: 37,
    enchants: []
  };
  let heldItem: TestItem | null = null;
  const addBlock = (name: string, position: Vec3) => {
    const blockData = mcData.blocksByName[name];
    if (!blockData) throw new Error(`Test fixture missing block '${name}'.`);
    const block: TestBlock = {
      name,
      type: blockData.id,
      position,
      canHarvest: sinon.stub().returns(true)
    };
    blocks.set(position.toString(), block);
    return block;
  };
  const pathfinderGoto = sinon.stub().callsFake(async (goal: { x: number; y: number; z: number }) => {
    startPosition.set(goal.x, goal.y, goal.z);
  });
  const dig = sinon.stub().callsFake(async (block: TestBlock) => {
    blocks.delete(block.position.toString());
  });
  const bot = {
    version: '1.21.8',
    entity: { position: startPosition, yaw: -Math.PI / 2 },
    inventory: {
      slots: Array(45).fill(null),
      items: () => [pickaxe, torch]
    },
    blockAt: (position: Vec3) => blocks.get(position.toString()) ?? {
      name: 'air',
      type: mcData.blocksByName.air.id,
      position,
      canHarvest: () => false
    },
    canDigBlock: sinon.stub().callsFake(() => true),
    canSeeBlock: () => true,
    get heldItem() {
      return heldItem;
    },
    equip: sinon.stub().callsFake(async (item: TestItem) => {
      heldItem = item;
    }),
    dig,
    lookAt: sinon.stub().resolves(),
    placeBlock: sinon.stub().callsFake(async (referenceBlock: TestBlock, face: Vec3) => {
      const target = referenceBlock.position.plus(face);
      addBlock('torch', target);
    }),
    clearControlStates: sinon.stub(),
    stopDigging: sinon.stub(),
    pathfinder: {
      goto: pathfinderGoto,
      stop: sinon.stub()
    }
  };
  return {
    bot: bot as unknown as mineflayer.Bot,
    addBlock,
    blocks,
    dig,
    pathfinderGoto,
    pickaxe,
    torch,
    get heldItem() {
      return heldItem;
    }
  };
}

function createRunner(bot: mineflayer.Bot) {
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const connection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  return new StripMiningRunner(new ToolFactory(server, connection), () => bot);
}

async function waitForTerminalStatus(
  runner: { getStatus: () => StripMiningStatus | null },
  timeoutMs = 5_000
): Promise<StripMiningStatus> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = runner.getStatus();
    if (status && status.state !== 'running') return status;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Strip mining did not reach a terminal state before the test timeout.');
}

function addTunnel(bot: ReturnType<typeof createBot>, startX: number, length: number, y = 64, z = 0) {
  for (let step = 1; step <= length; step += 1) {
    for (let height = 0; height < 2; height += 1) {
      bot.addBlock('stone', new Vec3(startX + step, y + height, z));
    }
    bot.addBlock('stone', new Vec3(startX + step, y - 1, z));
  }
}

test('registers strip mining start, status, and stop tools', t => {
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const connection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(server, connection);

  registerStripMiningTools(factory, () => ({} as mineflayer.Bot));

  const calls = (server.tool as sinon.SinonStub).getCalls();
  t.true(calls.some(call => call.args[0] === 'strip-mine'));
  t.true(calls.some(call => call.args[0] === 'get-strip-mining-status'));
  t.true(calls.some(call => call.args[0] === 'stop-strip-mining'));
});

test('mines a bounded straight 1x2 tunnel with the selected pickaxe', async t => {
  const fixture = createBot();
  addTunnel(fixture, 0, 3);
  const runner = createRunner(fixture.bot);

  const started = runner.start({
    length: 3,
    direction: 'east',
    targetY: 64,
    branchOreTypes: [],
    placeTorches: false
  });
  const status = await waitForTerminalStatus(runner);

  t.is(started.state, 'running');
  t.is(status.state, 'completed');
  t.is(status.stepsMined, 3);
  t.is(status.blocksDug, 6);
  t.is(status.tunnelWidth, 1);
  t.is(status.tunnelHeight, 2);
  t.true((fixture.bot.equip as sinon.SinonStub).calledWith(fixture.pickaxe, 'hand'));
});

test('descends a staircase to target Y before starting the straight tunnel', async t => {
  const fixture = createBot(new Vec3(0, 66, 0));
  for (let step = 1; step <= 2; step += 1) {
    const nextFeet = new Vec3(step, 66 - step, 0);
    fixture.addBlock('stone', nextFeet);
    fixture.addBlock('stone', nextFeet.offset(0, 1, 0));
    fixture.addBlock('stone', nextFeet.offset(0, -1, 0));
  }
  fixture.addBlock('stone', new Vec3(3, 64, 0));
  fixture.addBlock('stone', new Vec3(3, 65, 0));
  const runner = createRunner(fixture.bot);

  runner.start({
    length: 1,
    direction: 'east',
    targetY: 64,
    branchOreTypes: [],
    placeTorches: false
  });
  const status = await waitForTerminalStatus(runner);

  t.is(status.state, 'completed');
  t.is(status.staircaseSteps, 2);
  t.is(status.stepsMined, 1);
  t.is(status.blocksDug, 6);
  t.deepEqual(fixture.bot.entity.position.floored(), new Vec3(3, 64, 0));
});

test('branches to exposed configured ores and mines them with a compatible tool', async t => {
  const fixture = createBot();
  addTunnel(fixture, 0, 1);
  fixture.addBlock('coal_ore', new Vec3(2, 64, 1));
  (fixture.bot.canDigBlock as sinon.SinonStub).callsFake((block: TestBlock) =>
    Math.hypot(
      block.position.x - fixture.bot.entity.position.x,
      block.position.y - fixture.bot.entity.position.y,
      block.position.z - fixture.bot.entity.position.z
    ) <= 1.5
  );
  const runner = createRunner(fixture.bot);

  runner.start({
    length: 1,
    direction: 'east',
    targetY: 64,
    branchOreTypes: ['coal_ore'],
    branchSearchRadius: 4,
    placeTorches: false
  });
  const status = await waitForTerminalStatus(runner);

  t.is(status.state, 'completed');
  t.is(status.oreBlocksDug, 1);
  t.is(status.branchOreBlocksDug, 1);
  t.false(fixture.blocks.has(new Vec3(2, 64, 1).toString()));
});

test('places torches at the configured spacing when enabled', async t => {
  const fixture = createBot();
  addTunnel(fixture, 0, 2);
  fixture.addBlock('stone', new Vec3(0, 63, 0));
  const runner = createRunner(fixture.bot);

  runner.start({
    length: 2,
    direction: 'east',
    targetY: 64,
    branchOreTypes: [],
    placeTorches: true,
    torchSpacing: 1
  });
  const status = await waitForTerminalStatus(runner);

  t.is(status.state, 'completed');
  t.is(status.torchesPlaced, 2);
  t.true((fixture.bot.equip as sinon.SinonStub).calledWith(fixture.torch, 'hand'));
});

test('validates tunnel dimensions, target height, and bounded length', t => {
  const fixture = createBot();
  const runner = createRunner(fixture.bot);

  const narrowTunnel = t.throws(() => runner.start({ tunnelHeight: 1 }));
  const aboveBot = t.throws(() => runner.start({ targetY: 65 }));
  const overlong = t.throws(() => runner.start({ length: 129 }));

  t.truthy(narrowTunnel?.message.includes('tunnelHeight'));
  t.truthy(aboveBot?.message.includes('cannot be above'));
  t.truthy(overlong?.message.includes('length'));
});

test('rejects invalid branch targets', t => {
  const fixture = createBot();
  const runner = createRunner(fixture.bot);

  const error = t.throws(() => runner.start({ branchOreTypes: ['stone'] }));

  t.truthy(error?.message.includes('must be an ore block'));
});

test('stops safely before digging into lava', async t => {
  const fixture = createBot();
  fixture.addBlock('lava', new Vec3(1, 64, 0));
  const runner = createRunner(fixture.bot);

  runner.start({ length: 1, direction: 'east', targetY: 64, branchOreTypes: [], placeTorches: false });
  const status = await waitForTerminalStatus(runner);

  t.is(status.state, 'incomplete');
  t.true(status.message.includes('lava'));
  t.is(fixture.dig.callCount, 0);
});

test('mines the configured tunnel width and height', async t => {
  const fixture = createBot();
  for (let side = 0; side < 2; side += 1) {
    for (let height = 0; height < 3; height += 1) {
      fixture.addBlock('stone', new Vec3(1, 64 + height, side));
    }
  }
  const runner = createRunner(fixture.bot);
  const options: StripMiningOptions = {
    direction: 'east',
    length: 1,
    targetY: 64,
    tunnelWidth: 2,
    tunnelHeight: 3,
    branchOreTypes: [],
    placeTorches: false
  };

  const started = runner.start(options);
  const status = await waitForTerminalStatus(runner);

  t.is(started.tunnelWidth, 2);
  t.is(started.tunnelHeight, 3);
  t.is(status.state, 'completed');
  t.is(status.blocksDug, 6);
});

test('cancels while pathfinding and reaches a stopped state', async t => {
  const fixture = createBot();
  let notifyPathfindingStarted!: () => void;
  const pathfindingStarted = new Promise<void>(resolve => {
    notifyPathfindingStarted = resolve;
  });
  fixture.pathfinderGoto.callsFake(async () => {
    notifyPathfindingStarted();
    return new Promise<void>(() => {});
  });
  const runner = createRunner(fixture.bot);

  runner.start({
    length: 1,
    direction: 'east',
    targetY: 64,
    branchOreTypes: [],
    placeTorches: false
  });
  await pathfindingStarted;
  t.true(runner.stop().includes('Cancellation requested'));

  const status = await waitForTerminalStatus(runner);
  t.is(status.state, 'stopped');
  t.is(fixture.bot.pathfinder.stop.callCount, 1);
});
