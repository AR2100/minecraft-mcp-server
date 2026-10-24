import test from 'ava';
import sinon from 'sinon';
import { ToolFactory } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';

test('createResponse returns proper MCP response format', (t) => {
  const mockServer = {} as McpServer;
  const mockConnection = {} as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  
  const response = factory.createResponse('Test message');
  
  t.deepEqual(response, {
    content: [{ type: 'text', text: 'Test message' }]
  });
});

test('createResponse handles empty string', (t) => {
  const mockServer = {} as McpServer;
  const mockConnection = {} as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  
  const response = factory.createResponse('');
  
  t.deepEqual(response, {
    content: [{ type: 'text', text: '' }]
  });
});

test('createErrorResponse with Error object', (t) => {
  const mockServer = {} as McpServer;
  const mockConnection = {} as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  
  const error = new Error('Connection timeout');
  const response = factory.createErrorResponse(error);
  
  t.deepEqual(response, {
    content: [{ type: 'text', text: 'Failed: Connection timeout' }],
    isError: true
  });
});

test('createErrorResponse with string', (t) => {
  const mockServer = {} as McpServer;
  const mockConnection = {} as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  
  const response = factory.createErrorResponse('Invalid argument');
  
  t.deepEqual(response, {
    content: [{ type: 'text', text: 'Failed: Invalid argument' }],
    isError: true
  });
});

test('createErrorResponse includes isError flag', (t) => {
  const mockServer = {} as McpServer;
  const mockConnection = {} as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  
  const response = factory.createErrorResponse('Error occurred');
  
  t.true(response.isError === true);
});

test('registerTool calls server.tool with correct parameters', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  
  const factory = new ToolFactory(mockServer, mockConnection);
  const schema = { type: 'object', properties: {} };
  const executor = sinon.stub().resolves({ content: [{ type: 'text', text: 'Success' }] });
  
  factory.registerTool('test_tool', 'A test tool', schema, executor);
  
  t.true((mockServer.tool as sinon.SinonStub).calledOnce);
  t.is((mockServer.tool as sinon.SinonStub).firstCall.args[0], 'test_tool');
  t.is((mockServer.tool as sinon.SinonStub).firstCall.args[1], 'A test tool');
  t.is((mockServer.tool as sinon.SinonStub).firstCall.args[2], schema);
});

test('registerTool executor checks connection before executing', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  
  const factory = new ToolFactory(mockServer, mockConnection);
  const executor = sinon.stub().resolves({ content: [{ type: 'text', text: 'Success' }] });
  
  factory.registerTool('test_tool', 'A test tool', {}, executor);
  
  const registeredExecutor = (mockServer.tool as sinon.SinonStub).firstCall.args[3];
  await registeredExecutor({ arg: 'value' });
  
  t.true((mockConnection.checkConnectionAndReconnect as sinon.SinonStub).calledOnce);
});

test('registerTool executor returns error when not connected', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ 
      connected: false, 
      message: 'Bot is not connected' 
    })
  } as unknown as BotConnection;
  
  const factory = new ToolFactory(mockServer, mockConnection);
  const executor = sinon.stub().resolves({ content: [{ type: 'text', text: 'Success' }] });
  
  factory.registerTool('test_tool', 'A test tool', {}, executor);
  
  const registeredExecutor = (mockServer.tool as sinon.SinonStub).firstCall.args[3];
  const response = await registeredExecutor({ arg: 'value' });
  
  t.deepEqual(response, {
    content: [{ type: 'text', text: 'Bot is not connected' }],
    isError: true
  });
  t.true((executor as sinon.SinonStub).notCalled);
});

test('registerTool executor calls executor when connected', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  
  const factory = new ToolFactory(mockServer, mockConnection);
  const executor = sinon.stub().resolves({ content: [{ type: 'text', text: 'Success' }] });
  
  factory.registerTool('test_tool', 'A test tool', {}, executor);
  
  const registeredExecutor = (mockServer.tool as sinon.SinonStub).firstCall.args[3];
  const args = { arg: 'value' };
  await registeredExecutor(args);
  
  t.true((executor as sinon.SinonStub).calledOnceWith(args));
});

test('registerTool executor returns executor result when successful', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  
  const factory = new ToolFactory(mockServer, mockConnection);
  const expectedResponse = { content: [{ type: 'text', text: 'Tool executed' }] };
  const executor = sinon.stub().resolves(expectedResponse);
  
  factory.registerTool('test_tool', 'A test tool', {}, executor);
  
  const registeredExecutor = (mockServer.tool as sinon.SinonStub).firstCall.args[3];
  const response = await registeredExecutor({ arg: 'value' });
  
  t.deepEqual(response, expectedResponse);
});

test('registerTool executor catches and returns error response on exception', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  
  const factory = new ToolFactory(mockServer, mockConnection);
  const error = new Error('Execution failed');
  const executor = sinon.stub().rejects(error);
  
  factory.registerTool('test_tool', 'A test tool', {}, executor);
  
  const registeredExecutor = (mockServer.tool as sinon.SinonStub).firstCall.args[3];
  const response = await registeredExecutor({ arg: 'value' });
  
  t.deepEqual(response, {
    content: [{ type: 'text', text: 'Failed: Execution failed' }],
    isError: true
  });
});

test('exclusive operation blocks normal tools but allows control tools', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const regularExecutor = sinon.stub().resolves({ content: [{ type: 'text', text: 'regular' }] });
  const controlExecutor = sinon.stub().resolves({ content: [{ type: 'text', text: 'control' }] });

  factory.registerTool('regular-tool', 'A regular tool', {}, regularExecutor);
  factory.registerTool(
    'control-tool',
    'A control tool',
    {},
    controlExecutor,
    { allowDuringExclusiveOperation: true }
  );
  const regularHandler = (mockServer.tool as sinon.SinonStub).getCalls()[0].args[3];
  const controlHandler = (mockServer.tool as sinon.SinonStub).getCalls()[1].args[3];
  const release = factory.beginExclusiveOperation('test action');

  const regularResult = await regularHandler({});
  const controlResult = await controlHandler({});

  t.true(regularResult.isError);
  t.true(regularResult.content[0].text.includes('test action is active'));
  t.true((regularExecutor as sinon.SinonStub).notCalled);
  t.deepEqual(controlResult, { content: [{ type: 'text', text: 'control' }] });
  t.true((controlExecutor as sinon.SinonStub).calledOnce);

  release();
  await regularHandler({});
  t.true((regularExecutor as sinon.SinonStub).calledOnce);
});

test('exclusive operation cannot begin while another bot tool is running', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  let releaseExecutor!: (response: { content: { type: 'text'; text: string }[] }) => void;
  let signalExecutorStarted!: () => void;
  const executorStarted = new Promise<void>(resolve => {
    signalExecutorStarted = resolve;
  });
  const executor = sinon.stub().callsFake(() => new Promise(resolve => {
    releaseExecutor = resolve;
    signalExecutorStarted();
  }));

  factory.registerTool('slow-tool', 'A slow tool', {}, executor);
  const handler = (mockServer.tool as sinon.SinonStub).firstCall.args[3];
  const toolCall = handler({});
  await executorStarted;

  t.throws(
    () => factory.beginExclusiveOperation('test action'),
    { message: 'Cannot start test action while another bot tool is running. Try again when it finishes.' }
  );

  releaseExecutor({ content: [{ type: 'text', text: 'done' }] });
  await toolCall;
  const release = factory.beginExclusiveOperation('test action');
  release();
});
