import type { QueueAttributeName } from '@aws-sdk/client-sqs';

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
}

export interface SqsMicroserviceOptions {
  queues: SqsQueueConfig[];
  pollingIntervalMs?: number;
}
