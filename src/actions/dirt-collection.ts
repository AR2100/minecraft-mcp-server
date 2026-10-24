import {
  BlockCollectionArea,
  BlockCollectionRunner,
  BlockCollectionState,
  BlockCollectionStatus
} from './block-collection.js';
import type mineflayer from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';

export type DirtCollectionArea = BlockCollectionArea;
export type DirtCollectionState = BlockCollectionState;
export type DirtCollectionStatus = BlockCollectionStatus;

export class DirtCollectionRunner {
  private runner: BlockCollectionRunner;

  constructor(
    factory: ToolFactory,
    getBot: () => mineflayer.Bot
  ) {
    this.runner = new BlockCollectionRunner(factory, getBot);
  }

  start(targetCount: number, area: DirtCollectionArea): DirtCollectionStatus {
    return this.runner.start('dirt', targetCount, area);
  }

  getStatus(): DirtCollectionStatus | null {
    return this.runner.getStatus();
  }

  stop(): string {
    return this.runner.stop();
  }
}
