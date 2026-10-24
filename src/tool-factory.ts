import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, ZodError, ZodRawShape, ZodType } from "zod";
import { BotConnection } from './bot-connection.js';

type McpResponse = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
};

interface ToolRegistrationOptions {
  allowDuringExclusiveOperation?: boolean;
}

export class ToolFactory {
  private activeToolCalls = 0;
  private exclusiveOperation: string | null = null;

  constructor(
    private server: McpServer,
    private connection: BotConnection
  ) {}

  registerTool(
    name: string,
    description: string,
    schema: Record<string, unknown>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executor: (args: any) => Promise<McpResponse>,
    options: ToolRegistrationOptions = {}
  ): void {
    this.server.tool(name, description, schema, async (args: unknown): Promise<McpResponse> => {
      const connectionCheck = await this.connection.checkConnectionAndReconnect();

      if (!connectionCheck.connected) {
        return {
          content: [{ type: "text", text: connectionCheck.message! }],
          isError: true
        };
      }

      try {
        const parsedArgs = this.shouldValidateSchema(schema)
          ? this.parseArgs(schema as ZodRawShape, args)
          : args;
        const releaseToolCall = options.allowDuringExclusiveOperation
          ? undefined
          : this.beginToolCall(name);

        try {
          return await executor(parsedArgs);
        } finally {
          releaseToolCall?.();
        }
      } catch (error) {
        return this.createErrorResponse(error as Error);
      }
    });
  }

  beginExclusiveOperation(name: string): () => void {
    if (this.exclusiveOperation) {
      throw new Error(`Cannot start ${name} while ${this.exclusiveOperation} is active.`);
    }
    if (this.activeToolCalls > 0) {
      throw new Error(`Cannot start ${name} while another bot tool is running. Try again when it finishes.`);
    }

    this.exclusiveOperation = name;
    let released = false;

    return () => {
      if (!released && this.exclusiveOperation === name) {
        this.exclusiveOperation = null;
        released = true;
      }
    };
  }

  createResponse(text: string): McpResponse {
    return {
      content: [{ type: "text", text }]
    };
  }

  createErrorResponse(error: Error | string): McpResponse {
    const errorMessage = error instanceof Error ? error.message : error;
    return {
      content: [{ type: "text", text: `Failed: ${errorMessage}` }],
      isError: true
    };
  }

  private beginToolCall(name: string): () => void {
    if (this.exclusiveOperation) {
      throw new Error(`Cannot run '${name}' while ${this.exclusiveOperation} is active. Check its status or stop it first.`);
    }

    this.activeToolCalls += 1;
    let released = false;

    return () => {
      if (!released) {
        this.activeToolCalls -= 1;
        released = true;
      }
    };
  }

  private shouldValidateSchema(schema: Record<string, unknown>): boolean {
    const values = Object.values(schema);
    if (values.length === 0) {
      return true;
    }

    return values.every((value) => value instanceof ZodType);
  }

  private parseArgs(schema: ZodRawShape, args: unknown): unknown {
    try {
      return z.object(schema).passthrough().parse(args ?? {});
    } catch (error) {
      if (error instanceof ZodError) {
        throw new Error(this.formatZodError(error));
      }
      throw error;
    }
  }

  private formatZodError(error: ZodError): string {
    const details = error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
        return `${path}${issue.message}`;
      })
      .join('; ');

    return `Invalid tool arguments: ${details}`;
  }
}
