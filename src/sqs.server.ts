import {
  Message,
  ReceiveMessageCommand,
  type ReceiveMessageCommandInput,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { Logger, type LoggerService } from '@nestjs/common';
import {
  CustomTransportStrategy,
  Server,
  type MsPattern,
} from '@nestjs/microservices';
import { lastValueFrom } from 'rxjs';
import { SqsContext } from './sqs.context.js';
import type {
  SqsMicroserviceOptions,
  SqsPattern,
  SqsQueueConfig,
} from './sqs.types.js';

const DEFAULT_POLLING_INTERVAL_MS = 1000;
const DEFAULT_BATCH_SIZE = 1;
const DEFAULT_WAIT_TIME_SECONDS = 20;

export class SqsServer extends Server implements CustomTransportStrategy {
  private readonly sqsLogger: LoggerService;
  private running = false;

  constructor(
    private readonly options: SqsMicroserviceOptions,
    private readonly sqsClient: SQSClient,
    logger?: LoggerService,
  ) {
    super();
    this.sqsLogger = logger ?? new Logger(SqsServer.name);
  }

  on(): this {
    return this;
  }

  unwrap<T>(): T {
    return undefined as unknown as T;
  }

  listen(callback: () => void): void {
    this.running = true;
    for (const queue of this.options.queues) {
      void this.startPolling(queue);
    }
    callback?.();
  }

  close(): void {
    this.running = false;
  }

  private async startPolling(queue: SqsQueueConfig): Promise<void> {
    while (this.running) {
      try {
        const commandInput: ReceiveMessageCommandInput = {
          QueueUrl: queue.queueUrl,
          MaxNumberOfMessages: queue.batchSize ?? DEFAULT_BATCH_SIZE,
          WaitTimeSeconds: queue.waitTimeSeconds ?? DEFAULT_WAIT_TIME_SECONDS,
          VisibilityTimeout: queue.visibilityTimeout,
          AttributeNames: queue.attributeNames ?? ['All'],
          MessageAttributeNames: queue.messageAttributeNames ?? ['All'],
        };

        const response = await this.sqsClient.send(
          new ReceiveMessageCommand(commandInput),
        );

        if (!response.Messages || response.Messages.length === 0) {
          continue;
        }

        for (const message of response.Messages) {
          await this.processMessage(queue, message);
        }
      } catch (error) {
        const queueUrl = String(queue.queueUrl);
        this.sqsLogger.error?.(
          `Failed to poll queue ${queueUrl}`,
          error instanceof Error ? error.stack : String(error),
        );
        await this.delay(
          this.options.pollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS,
        );
      }
    }
  }

  private async processMessage(
    queue: SqsQueueConfig,
    message: Message,
  ): Promise<void> {
    const handler = this.getHandler(queue.pattern);
    if (!handler) {
      const patternLabel = JSON.stringify(queue.pattern);
      this.sqsLogger.warn?.(
        `No handler registered for pattern ${patternLabel}.`,
      );
      return;
    }

    const context = new SqsContext(this.sqsClient, queue.queueUrl, message);

    try {
      const result = handler(message, context);
      const response$ = this.transformToObservable(result as never);
      await lastValueFrom(response$);

      if (queue.deleteMessageOnSuccess ?? true) {
        await context.deleteMessage();
      }
    } catch (error) {
      const patternLabel = JSON.stringify(queue.pattern);
      this.sqsLogger.error?.(
        `Handler for pattern ${patternLabel} failed`,
        error instanceof Error ? error.stack : String(error),
      );

      if (queue.requeueOnError === false) {
        await context.deleteMessage();
      }
    }
  }

  private getHandler(
    pattern: SqsPattern,
  ): ((message: Message, context: SqsContext) => unknown) | undefined {
    const normalized = this.normalizePattern(pattern as MsPattern);
    const baseHandler = this.getHandlerByPattern(normalized);
    if (!baseHandler) {
      return undefined;
    }
    return (message: Message, context: SqsContext) =>
      baseHandler(message, context);
  }

  private async delay(ms: number): Promise<void> {
    if (ms <= 0) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}
