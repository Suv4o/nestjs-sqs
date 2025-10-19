import type {
  MessageAttributeValue,
  QueueAttributeName,
  SQSClient,
  SQSClientConfig,
} from '@aws-sdk/client-sqs';
import type { LoggerService } from '@nestjs/common';

export type SqsPattern = string | number | Record<string, unknown>;

export interface SqsQueueConfig {
  pattern: SqsPattern;
  queueUrl: string;
  batchSize?: number;
  waitTimeSeconds?: number;
  visibilityTimeout?: number;
  attributeNames?: QueueAttributeName[];
  messageAttributeNames?: string[];
  deleteMessageOnSuccess?: boolean;
  requeueOnError?: boolean;
  isFifo?: boolean;
  defaultGroupId?: string;
  defaultDeduplicationId?: string;
  defaultDelaySeconds?: number;
}

export interface SqsMicroserviceOptions {
  queues: SqsQueueConfig[];
  pollingIntervalMs?: number;
}

export interface SqsOutboundMessage<T = unknown> {
  body: T;
  messageAttributes?: Record<string, MessageAttributeValue>;
  groupId?: string;
  deduplicationId?: string;
  delaySeconds?: number;
}

export type SqsOutboundPayload<T = unknown> = T | SqsOutboundMessage<T>;

export interface SqsSendCommandOptions {
  messageAttributes?: Record<string, MessageAttributeValue>;
  groupId?: string;
  deduplicationId?: string;
  delaySeconds?: number;
}

export interface SqsClientResponseQueueOptions {
  queueUrl: string;
  waitTimeSeconds?: number;
  attributeNames?: QueueAttributeName[];
  messageAttributeNames?: string[];
  deleteMessageOnSuccess?: boolean;
  batchSize?: number;
}

export interface SqsClientOptions {
  queues: SqsQueueConfig[];
  responseQueue?: SqsClientResponseQueueOptions;
  pollingIntervalMs?: number;
  client?: SQSClient;
  clientConfig?: SQSClientConfig;
  logger?: LoggerService;
}

export interface SqsRequestEnvelope<T = unknown> {
  id: string;
  pattern: SqsPattern;
  data: T;
  isEvent: boolean;
}

export interface SqsResponseEnvelope<T = unknown> {
  id: string;
  response?: T;
  err?: unknown;
  isDisposed?: boolean;
}
