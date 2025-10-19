import {
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type MessageAttributeValue,
  type ReceiveMessageCommandInput,
  SQSClient,
  type SendMessageCommandOutput,
} from '@aws-sdk/client-sqs';
import { Logger, type LoggerService } from '@nestjs/common';
import {
  ClientProxy,
  type ReadPacket,
  type WritePacket,
} from '@nestjs/microservices';
import { randomUUID } from 'node:crypto';
import {
  SQS_NEST_CORRELATION_ID_ATTR,
  SQS_NEST_PACKET_TYPE_ATTR,
  SQS_NEST_PACKET_TYPE_EVENT,
  SQS_NEST_PACKET_TYPE_REQUEST,
  SQS_NEST_REPLY_QUEUE_ATTR,
} from './sqs.constants.js';
import type {
  SqsClientResponseQueueOptions,
  SqsClientOptions,
  SqsOutboundMessage,
  SqsOutboundPayload,
  SqsQueueConfig,
  SqsRequestEnvelope,
  SqsResponseEnvelope,
  SqsSendCommandOptions,
} from './sqs.types.js';

const DEFAULT_POLLING_INTERVAL_MS = 1000;

interface NormalizedOutbound<T = unknown> {
  payload: T;
  options: SqsSendCommandOptions;
}

export class SqsClient extends ClientProxy {
  private readonly logger: LoggerService;
  private readonly queueMap = new Map<string, SqsQueueConfig>();
  private readonly sqsClient: SQSClient;
  private readonly responseQueue?: SqsClientResponseQueueOptions;
  private readonly pollingIntervalMs: number;
  private isConnected = false;
  private isResponsePolling = false;
  private responsePollingPromise?: Promise<void>;

  constructor(options: SqsClientOptions) {
    super();
    this.logger = options.logger ?? new Logger(SqsClient.name);
    this.sqsClient =
      options.client ?? new SQSClient(options.clientConfig ?? {});
    this.responseQueue = options.responseQueue;
    this.pollingIntervalMs =
      options.pollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS;

    if (options.queues.length === 0) {
      throw new Error('At least one queue configuration is required.');
    }

    for (const queue of options.queues) {
      const key = this.getPatternKey(queue.pattern);
      if (this.queueMap.has(key)) {
        throw new Error(
          `Duplicate queue pattern detected for ${key}. Patterns must be unique.`,
        );
      }
      this.queueMap.set(key, queue);
    }
  }

  connect(): Promise<this> {
    if (!this.isConnected) {
      this.isConnected = true;
      if (this.responseQueue) {
        this.startResponsePolling();
      }
    }

    return Promise.resolve(this);
  }

  close(): void {
    this.isConnected = false;
    this.stopResponsePolling();
    this.routingMap.clear();
  }

  unwrap<T>(): T {
    return undefined as unknown as T;
  }

  protected publish(
    packet: ReadPacket,
    callback: (packet: WritePacket) => void,
  ): () => void {
    const packetWithId = this.assignPacketId(packet);
    const queue = this.getQueue(packetWithId.pattern);
    if (!queue) {
      callback({
        err: new Error(
          `No queue configured for pattern ${JSON.stringify(packetWithId.pattern)}.`,
        ),
        isDisposed: true,
      });
      return () => undefined;
    }

    const correlationKey = String(packetWithId.id ?? randomUUID());
    packetWithId.id = correlationKey;

    const { payload, options } = this.normalizeOutboundPayload(
      packetWithId.data as SqsOutboundPayload,
      queue,
    );

    const envelope: SqsRequestEnvelope = {
      id: correlationKey,
      pattern: packetWithId.pattern ?? queue.pattern,
      data: payload,
      isEvent: false,
    };

    if (this.responseQueue) {
      this.routingMap.set(correlationKey, callback);
    }

    void this.sendMessage(queue, envelope, options, false)
      .then((result) => {
        if (!this.responseQueue) {
          callback({ response: result });
          callback({ isDisposed: true });
          this.routingMap.delete(correlationKey);
        }
      })
      .catch((error) => {
        callback({
          err: this.normalizeError(error),
          isDisposed: true,
        });
        this.routingMap.delete(correlationKey);
      });

    return () => {
      this.routingMap.delete(correlationKey);
    };
  }

  protected async dispatchEvent(packet: ReadPacket): Promise<any> {
    const packetWithId = this.assignPacketId(packet);
    const queue = this.getQueue(packetWithId.pattern);
    if (!queue) {
      throw new Error(
        `No queue configured for pattern ${JSON.stringify(packetWithId.pattern)}.`,
      );
    }

    const correlationId = String(packetWithId.id ?? randomUUID());
    packetWithId.id = correlationId;
    const { payload, options } = this.normalizeOutboundPayload(
      packetWithId.data as SqsOutboundPayload,
      queue,
    );

    const envelope: SqsRequestEnvelope = {
      id: correlationId,
      pattern: packetWithId.pattern ?? queue.pattern,
      data: payload,
      isEvent: true,
    };

    await this.sendMessage(queue, envelope, options, true);
  }

  private getQueue(pattern: unknown): SqsQueueConfig | undefined {
    const key = this.getPatternKey(pattern);
    return this.queueMap.get(key);
  }

  private getPatternKey(pattern: unknown): string {
    if (typeof pattern === 'string') {
      return pattern;
    }

    if (typeof pattern === 'number') {
      return String(pattern);
    }

    return JSON.stringify(pattern ?? '');
  }

  private normalizeOutboundPayload<T = unknown>(
    value: SqsOutboundPayload<T>,
    queue: SqsQueueConfig,
  ): NormalizedOutbound<T> {
    if (this.isOutboundMessage(value)) {
      const envelope = value;
      return {
        payload: envelope.body,
        options: {
          messageAttributes: envelope.messageAttributes,
          groupId:
            envelope.groupId ??
            queue.defaultGroupId ??
            this.fallbackGroupId(queue),
          deduplicationId:
            envelope.deduplicationId ??
            queue.defaultDeduplicationId ??
            this.fallbackDeduplicationId(queue),
          delaySeconds: envelope.delaySeconds ?? queue.defaultDelaySeconds,
        },
      };
    }

    return {
      payload: value,
      options: {
        groupId: queue.defaultGroupId ?? this.fallbackGroupId(queue),
        deduplicationId:
          queue.defaultDeduplicationId ?? this.fallbackDeduplicationId(queue),
        delaySeconds: queue.defaultDelaySeconds,
      },
    };
  }

  private isOutboundMessage<T>(
    value: SqsOutboundPayload<T>,
  ): value is SqsOutboundMessage<T> {
    return value !== null && typeof value === 'object' && 'body' in value;
  }

  private fallbackGroupId(queue: SqsQueueConfig): string | undefined {
    if (!queue.isFifo && !queue.queueUrl.endsWith('.fifo')) {
      return undefined;
    }
    return randomUUID();
  }

  private fallbackDeduplicationId(queue: SqsQueueConfig): string | undefined {
    if (!queue.isFifo && !queue.queueUrl.endsWith('.fifo')) {
      return undefined;
    }
    return randomUUID();
  }

  private async sendMessage(
    queue: SqsQueueConfig,
    envelope: SqsRequestEnvelope,
    options: SqsSendCommandOptions,
    isEvent: boolean,
  ): Promise<SendMessageCommandOutput> {
    const body = this.serializeEnvelope({ ...envelope, isEvent }, 'request');

    const messageAttributes: Record<string, MessageAttributeValue> = {
      ...(options.messageAttributes ?? {}),
      [SQS_NEST_PACKET_TYPE_ATTR]: {
        DataType: 'String',
        StringValue: isEvent
          ? SQS_NEST_PACKET_TYPE_EVENT
          : SQS_NEST_PACKET_TYPE_REQUEST,
      },
    };

    if (!isEvent) {
      messageAttributes[SQS_NEST_CORRELATION_ID_ATTR] = {
        DataType: 'String',
        StringValue: envelope.id,
      };

      if (this.responseQueue) {
        messageAttributes[SQS_NEST_REPLY_QUEUE_ATTR] = {
          DataType: 'String',
          StringValue: this.responseQueue.queueUrl,
        };
      }
    }

    const messageGroupId = options.groupId;
    const messageDeduplicationId = options.deduplicationId;

    return this.sqsClient.send(
      new SendMessageCommand({
        QueueUrl: queue.queueUrl,
        MessageBody: body,
        MessageAttributes: messageAttributes,
        ...(messageGroupId ? { MessageGroupId: messageGroupId } : {}),
        ...(messageDeduplicationId
          ? { MessageDeduplicationId: messageDeduplicationId }
          : {}),
        ...(options.delaySeconds ? { DelaySeconds: options.delaySeconds } : {}),
      }),
    );
  }

  private startResponsePolling(): void {
    if (this.isResponsePolling || !this.responseQueue) {
      return;
    }

    this.isResponsePolling = true;
    this.responsePollingPromise = this.pollResponseQueue();
  }

  private stopResponsePolling(): void {
    this.isResponsePolling = false;
  }

  private async pollResponseQueue(): Promise<void> {
    const responseQueue = this.responseQueue;
    if (!responseQueue) {
      return;
    }

    while (this.isConnected && this.isResponsePolling) {
      try {
        const commandInput: ReceiveMessageCommandInput = {
          QueueUrl: responseQueue.queueUrl,
          MaxNumberOfMessages: responseQueue.batchSize ?? 10,
          WaitTimeSeconds: responseQueue.waitTimeSeconds ?? 20,
          AttributeNames: responseQueue.attributeNames ?? ['All'],
          MessageAttributeNames: responseQueue.messageAttributeNames ?? ['All'],
        };

        const response = await this.sqsClient.send(
          new ReceiveMessageCommand(commandInput),
        );

        if (!response.Messages || response.Messages.length === 0) {
          continue;
        }

        for (const message of response.Messages) {
          await this.handleResponseMessage(message);
        }
      } catch (error) {
        this.logger.error?.(
          'Failed to poll response queue',
          error instanceof Error ? error.stack : String(error),
        );
        await this.delay(this.pollingIntervalMs);
      }
    }
  }

  private async handleResponseMessage(message: Message): Promise<void> {
    const envelope = this.parseResponseEnvelope(message.Body);
    if (!envelope?.id) {
      this.logger.warn?.('Received response without correlation id.');
      await this.deleteResponseMessage(message);
      return;
    }

    const callback = this.routingMap.get(envelope.id);
    if (!callback) {
      this.logger.warn?.(
        `No callback registered for correlation id ${envelope.id}.`,
      );
      await this.deleteResponseMessage(message);
      return;
    }

    if (envelope.err !== undefined) {
      callback({ err: envelope.err, isDisposed: true });
      this.routingMap.delete(envelope.id);
    } else {
      if (envelope.response !== undefined) {
        callback({ response: envelope.response });
      }

      if (envelope.isDisposed ?? true) {
        callback({ isDisposed: true });
        this.routingMap.delete(envelope.id);
      }
    }

    await this.deleteResponseMessage(message);
  }

  private async deleteResponseMessage(message: Message): Promise<void> {
    const shouldDelete = this.responseQueue?.deleteMessageOnSuccess ?? true;
    const queueUrl = this.responseQueue?.queueUrl;
    if (!shouldDelete || !message.ReceiptHandle || !queueUrl) {
      return;
    }

    await this.sqsClient.send(
      new DeleteMessageCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
  }

  private parseResponseEnvelope(
    body?: string | null,
  ): SqsResponseEnvelope | undefined {
    if (!body) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(body) as Partial<SqsResponseEnvelope>;
      if (!parsed || typeof parsed !== 'object') {
        return undefined;
      }
      if (typeof parsed.id === 'string') {
        return parsed as SqsResponseEnvelope;
      }
    } catch {
      return undefined;
    }

    return undefined;
  }

  private serializeEnvelope(envelope: unknown, label: string): string {
    try {
      return JSON.stringify(envelope);
    } catch (error) {
      this.logger.error?.(
        `Failed to serialize ${label} envelope`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }

  private normalizeError(error: unknown): unknown {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    }

    return error;
  }

  private delay(ms: number): Promise<void> {
    if (ms <= 0) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}
