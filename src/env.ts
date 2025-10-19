import type { QueueAttributeName } from '@aws-sdk/client-sqs';
import { numberFromEnv } from './utils.js';
import type {
  SqsMicroserviceOptions,
  SqsPattern,
  SqsQueueConfig,
} from './sqs.types.js';

const DEFAULT_ENDPOINT_KEY = 'AWS_ENDPOINT_URL';
const DEFAULT_ACCOUNT_ID_KEY = 'AWS_ACCOUNT_ID';
const DEFAULT_ACCOUNT_ID = '000000000000';
const DEFAULT_BATCH_SIZE_KEY = 'SQS_MAX_MESSAGES';
const DEFAULT_WAIT_TIME_KEY = 'SQS_WAIT_TIME_SECONDS';
const DEFAULT_VISIBILITY_KEY = 'SQS_VISIBILITY_TIMEOUT';
const DEFAULT_POLLING_INTERVAL_KEY = 'SQS_ERROR_BACKOFF_MS';
const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_WAIT_TIME_SECONDS = 20;
const DEFAULT_VISIBILITY_TIMEOUT = 60;
const DEFAULT_POLLING_INTERVAL_MS = 1000;

type EnvRecord = Record<string, string | undefined>;

const readEnvValue = (env: EnvRecord, key?: string): string | undefined => {
  if (!key) {
    return undefined;
  }

  return env[key] ?? process.env[key];
};

const sanitizeEndpoint = (endpoint: string): string =>
  endpoint.replace(/\/$/, '');

const buildQueueUrl = (
  endpoint: string,
  accountId: string,
  queueName: string,
): string =>
  `${sanitizeEndpoint(endpoint)}/${accountId}/${queueName.replace(/^\//, '')}`;

interface QueueUrlResolutionOptions {
  queueUrlKey: string;
  queueNameKey: string;
  endpointKey: string;
  accountId: string;
}

const resolveQueueUrl = (
  env: EnvRecord,
  {
    queueUrlKey,
    queueNameKey,
    endpointKey,
    accountId,
  }: QueueUrlResolutionOptions,
): string => {
  const explicitQueueUrl = readEnvValue(env, queueUrlKey);
  if (explicitQueueUrl) {
    return explicitQueueUrl;
  }

  const queueName = readEnvValue(env, queueNameKey);
  const endpoint = readEnvValue(env, endpointKey);
  if (queueName && endpoint) {
    return buildQueueUrl(endpoint, accountId, queueName);
  }

  throw new Error(
    `Queue URL could not be resolved. Provide ${queueUrlKey} or ${queueNameKey} together with ${endpointKey}.`,
  );
};

export interface QueueFromEnvDefinition {
  pattern: SqsPattern;
  queueKey: string;
  queueUrlKey?: string;
  queueNameKey?: string;
  deleteMessageOnSuccess?: boolean;
  requeueOnError?: boolean;
  attributeNames?: QueueAttributeName[];
  messageAttributeNames?: string[];
  isFifo?: boolean;
  defaultGroupId?: string;
  defaultDeduplicationId?: string;
  defaultDelaySeconds?: number;
  defaults?: Partial<
    Pick<SqsQueueConfig, 'batchSize' | 'waitTimeSeconds' | 'visibilityTimeout'>
  >;
  batchSizeKey?: string;
  waitTimeSecondsKey?: string;
  visibilityTimeoutKey?: string;
}

export interface BuildSqsOptionsFromEnvSettings {
  env?: EnvRecord;
  defaults?: {
    batchSize?: number;
    waitTimeSeconds?: number;
    visibilityTimeout?: number;
    pollingIntervalMs?: number;
    accountId?: string;
  };
  endpointKey?: string;
  accountIdKey?: string;
  globalBatchSizeKey?: string;
  globalWaitTimeKey?: string;
  globalVisibilityKey?: string;
  globalPollingIntervalKey?: string;
}

export const buildSqsMicroserviceOptionsFromEnv = (
  definitions: QueueFromEnvDefinition[],
  settings?: BuildSqsOptionsFromEnvSettings,
): SqsMicroserviceOptions => {
  if (definitions.length === 0) {
    throw new Error(
      'At least one queue definition is required to configure the SQS microservice.',
    );
  }

  const env = settings?.env ?? process.env;
  const defaultSettings = settings?.defaults ?? {};
  const endpointKey = settings?.endpointKey ?? DEFAULT_ENDPOINT_KEY;
  const accountIdKey = settings?.accountIdKey ?? DEFAULT_ACCOUNT_ID_KEY;
  const globalBatchSizeKey =
    settings?.globalBatchSizeKey ?? DEFAULT_BATCH_SIZE_KEY;
  const globalWaitTimeKey =
    settings?.globalWaitTimeKey ?? DEFAULT_WAIT_TIME_KEY;
  const globalVisibilityKey =
    settings?.globalVisibilityKey ?? DEFAULT_VISIBILITY_KEY;
  const globalPollingIntervalKey =
    settings?.globalPollingIntervalKey ?? DEFAULT_POLLING_INTERVAL_KEY;

  const accountId =
    readEnvValue(env, accountIdKey) ??
    defaultSettings.accountId ??
    DEFAULT_ACCOUNT_ID;

  const pollingIntervalFallback =
    defaultSettings.pollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS;
  const pollingIntervalMs =
    numberFromEnv(
      readEnvValue(env, globalPollingIntervalKey),
      pollingIntervalFallback,
    ) ?? pollingIntervalFallback;

  const queues = definitions.map<SqsQueueConfig>((definition) => {
    const queueDefaults = definition.defaults ?? {};

    const queueUrlKey = definition.queueUrlKey ?? `${definition.queueKey}_URL`;
    const queueNameKey =
      definition.queueNameKey ?? `${definition.queueKey}_NAME`;
    const queueUrl = resolveQueueUrl(env, {
      queueUrlKey,
      queueNameKey,
      endpointKey,
      accountId,
    });

    const batchSizeFallback =
      queueDefaults.batchSize ??
      defaultSettings.batchSize ??
      DEFAULT_BATCH_SIZE;
    const waitTimeFallback =
      queueDefaults.waitTimeSeconds ??
      defaultSettings.waitTimeSeconds ??
      DEFAULT_WAIT_TIME_SECONDS;
    const visibilityFallback =
      queueDefaults.visibilityTimeout ??
      defaultSettings.visibilityTimeout ??
      DEFAULT_VISIBILITY_TIMEOUT;

    const batchSizeKey = definition.batchSizeKey ?? globalBatchSizeKey;
    const waitTimeKey = definition.waitTimeSecondsKey ?? globalWaitTimeKey;
    const visibilityKey =
      definition.visibilityTimeoutKey ?? globalVisibilityKey;

    const batchSize =
      numberFromEnv(readEnvValue(env, batchSizeKey), batchSizeFallback) ??
      batchSizeFallback;
    const waitTimeSeconds =
      numberFromEnv(readEnvValue(env, waitTimeKey), waitTimeFallback) ??
      waitTimeFallback;
    const visibilityTimeout =
      numberFromEnv(readEnvValue(env, visibilityKey), visibilityFallback) ??
      visibilityFallback;

    return {
      pattern: definition.pattern,
      queueUrl,
      batchSize,
      waitTimeSeconds,
      visibilityTimeout,
      attributeNames: definition.attributeNames,
      messageAttributeNames: definition.messageAttributeNames,
      deleteMessageOnSuccess: definition.deleteMessageOnSuccess,
      requeueOnError: definition.requeueOnError,
      isFifo: definition.isFifo,
      defaultGroupId: definition.defaultGroupId,
      defaultDeduplicationId: definition.defaultDeduplicationId,
      defaultDelaySeconds: definition.defaultDelaySeconds,
    };
  });

  return {
    queues,
    pollingIntervalMs,
  };
};
