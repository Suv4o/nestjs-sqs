import {
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type MessageAttributeValue,
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
import {
  SQS_NEST_CORRELATION_ID_ATTR,
  SQS_NEST_PACKET_TYPE_ATTR,
  SQS_NEST_PACKET_TYPE_EVENT,
  SQS_NEST_PACKET_TYPE_RESPONSE,
  SQS_NEST_REPLY_QUEUE_ATTR,
} from './sqs.constants.js';
import type {
  SqsMicroserviceOptions,
  SqsPattern,
  SqsQueueConfig,
  SqsRequestEnvelope,
  SqsResponseEnvelope,
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
    const envelope = this.parseRequestEnvelope(message.Body);
    const pattern = envelope?.pattern ?? queue.pattern;
    const handler = this.getHandler(pattern);
    if (!handler) {
      const patternLabel = JSON.stringify(pattern ?? queue.pattern);
      this.sqsLogger.warn?.(
        `No handler registered for pattern ${patternLabel}.`,
      );
      return;
    }

    const context = new SqsContext(this.sqsClient, queue.queueUrl, message);
    const payload = this.extractPayload(envelope, message);
    const replyTo = this.getMessageAttribute(
      message,
      SQS_NEST_REPLY_QUEUE_ATTR,
    );
    const correlationId =
      envelope?.id ??
      this.getMessageAttribute(message, SQS_NEST_CORRELATION_ID_ATTR);
    const packetType =
      this.getMessageAttribute(message, SQS_NEST_PACKET_TYPE_ATTR) ??
      (envelope?.isEvent ? SQS_NEST_PACKET_TYPE_EVENT : undefined);
    const isEvent = packetType === SQS_NEST_PACKET_TYPE_EVENT;

    try {
      const result = handler(payload, context);
      const response$ = this.transformToObservable(result as never);
      const finalResult = await lastValueFrom(response$);

      if (replyTo && correlationId && !isEvent) {
        await this.sendResponse(replyTo, {
          id: correlationId,
          response: finalResult,
          isDisposed: true,
        });
      }

      if (queue.deleteMessageOnSuccess ?? true) {
        await context.deleteMessage();
      }
    } catch (error) {
      const patternLabel = JSON.stringify(pattern ?? queue.pattern);
      this.sqsLogger.error?.(
        `Handler for pattern ${patternLabel} failed`,
        error instanceof Error ? error.stack : String(error),
      );

      if (replyTo && correlationId && !isEvent) {
        await this.sendResponse(replyTo, {
          id: correlationId,
          err: this.serializeError(error),
          isDisposed: true,
        });
      }

      if (queue.requeueOnError === false) {
        await context.deleteMessage();
      }
    }
  }

  private getHandler(
    pattern: SqsPattern,
  ): ((payload: unknown, context: SqsContext) => unknown) | undefined {
    const normalized = this.normalizePattern(pattern as MsPattern);
    const baseHandler = this.getHandlerByPattern(normalized);
    if (!baseHandler) {
      return undefined;
    }
    return (payload: unknown, context: SqsContext) =>
      baseHandler(payload, context);
  }

  private async delay(ms: number): Promise<void> {
    if (ms <= 0) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private parseRequestEnvelope(
    body?: string | null,
  ): SqsRequestEnvelope | undefined {
    if (!body) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(body) as Partial<SqsRequestEnvelope>;
      if (!parsed || typeof parsed !== 'object') {
        return undefined;
      }
      if (typeof parsed.id === 'string' && parsed.pattern !== undefined) {
        return parsed as SqsRequestEnvelope;
      }
    } catch {
      return undefined;
    }

    return undefined;
  }

  private extractPayload(
    envelope: SqsRequestEnvelope | undefined,
    message: Message,
  ): unknown {
    if (envelope) {
      return envelope.data;
    }

    if (message.Body) {
      try {
        return JSON.parse(message.Body);
      } catch {
        return message.Body;
      }
    }

    return message;
  }

  private getMessageAttribute(
    message: Message,
    key: string,
  ): string | undefined {
    const attribute = message.MessageAttributes?.[key];
    if (!attribute) {
      return undefined;
    }

    if (attribute.StringValue) {
      return attribute.StringValue;
    }

    if (attribute.BinaryValue) {
      try {
        return Buffer.from(attribute.BinaryValue).toString('utf8');
      } catch {
        return undefined;
      }
    }

    if (attribute.StringListValues && attribute.StringListValues.length > 0) {
      return attribute.StringListValues[0];
    }

    return undefined;
  }

  private async sendResponse(
    queueUrl: string,
    envelope: SqsResponseEnvelope,
  ): Promise<void> {
    const body = this.serializeEnvelope(envelope, 'response');
    const messageAttributes = {
      [SQS_NEST_PACKET_TYPE_ATTR]: {
        DataType: 'String',
        StringValue: SQS_NEST_PACKET_TYPE_RESPONSE,
      },
      [SQS_NEST_CORRELATION_ID_ATTR]: {
        DataType: 'String',
        StringValue: envelope.id,
      },
    } satisfies Record<string, MessageAttributeValue>;

    await this.sqsClient.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: body,
        MessageAttributes: messageAttributes,
      }),
    );
  }

  private serializeEnvelope(envelope: unknown, label: string): string {
    try {
      return JSON.stringify(envelope);
    } catch (error) {
      this.sqsLogger.error?.(
        `Failed to serialize ${label} envelope`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }

  private serializeError(error: unknown): unknown {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    }

    return error;
  }
}
