# @suv4o/nestjs-sqs

NestJS microservice transport strategy for AWS SQS that keeps the native `@MessagePattern()` workflow. Bring your own `SQSClient`, point the transport at one or more queues, and keep handling messages with standard Nest controllers.

## Features

- ✅ Native NestJS microservice API (`@MessagePattern`, `CustomTransportStrategy`)
- ✅ Native `.send()` / `.emit()` support via a dedicated Nest `ClientProxy`
- ✅ Poll multiple queues with independent batching and retry behaviour
- ✅ Helpers for building queue configs straight from environment variables
- ✅ Zero runtime dependencies beyond the AWS SDK v3 and NestJS peers

## Installation

```bash
npm install @suv4o/nestjs-sqs @aws-sdk/client-sqs
```

The transport expects the usual NestJS peer packages to already exist in your project (`@nestjs/common`, `@nestjs/core`, `@nestjs/microservices`, and `rxjs`).

## Quick start

```ts
import { Controller, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Message } from '@aws-sdk/client-sqs';
import { SQSClient } from '@aws-sdk/client-sqs';
import {
  SqsContext,
  SqsMessagePattern,
  SqsServer,
  buildSqsMicroserviceOptionsFromEnv,
} from '@suv4o/nestjs-sqs';

interface OrderCreatedEvent {
  orderId: string;
  customerId: string;
  items: Array<{ sku: string; quantity: number }>;
}

@Controller()
class OrdersController {
  @SqsMessagePattern('order-persistence')
  async handleOrder(
    payload: OrderCreatedEvent,
    context: SqsContext,
  ): Promise<void> {
    const rawMessage: Message = context.getMessage();
    // …your business logic using both the payload and the raw message if needed
  }
}

@Module({ controllers: [OrdersController] })
class OrdersModule {}

async function bootstrap(): Promise<void> {
  const sqsClient = new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    // The AWS SDK automatically reads credentials such as
    // AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY from the environment
    // or any other credential provider you configure.
  });

  const options = buildSqsMicroserviceOptionsFromEnv([
    {
      pattern: { cmd: 'order-persistence' },
      queueKey: 'ORDER_PERSISTENCE_QUEUE',
    },
  ]);

  const app = await NestFactory.createMicroservice(OrdersModule, {
    strategy: new SqsServer(options, sqsClient),
  });

  await app.listen();
}

void bootstrap();
```

## Sending messages with `.send()` / `.emit()`

The package also ships a Nest-compatible `ClientProxy` so you can produce
messages without relying on third-party libraries. Create the proxy with
`ClientProxyFactory` and point it at the queues you wish to use:

```ts
import { ClientProxyFactory } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { SQSClient } from '@aws-sdk/client-sqs';
import {
  SqsClient,
  type SqsClientOptions,
  type SqsOutboundMessage,
} from '@suv4o/nestjs-sqs';

const sqsClient = new SQSClient({ region: 'us-east-1' });

const client = ClientProxyFactory.create({
  customClass: SqsClient,
  options: {
    client: sqsClient,
    queues: [
      {
        pattern: { cmd: 'order-persistence' },
        queueUrl: process.env.ORDER_PERSISTENCE_QUEUE_URL!,
        isFifo: true,
      },
    ],
    responseQueue: {
      queueUrl: process.env.ORDER_RESPONSES_QUEUE_URL!,
    },
  } satisfies SqsClientOptions,
});

await client.connect();

const eventPayload: OrderCreatedEvent = /* … */;

const message: SqsOutboundMessage<OrderCreatedEvent> = {
  body: eventPayload,
  messageAttributes: {
    event_type: { DataType: 'String', StringValue: 'order.created' },
  },
  groupId: eventPayload.customerId,
  deduplicationId: eventPayload.orderId,
};

// Fire-and-forget
await firstValueFrom(client.emit({ cmd: 'order-persistence' }, message));

// RPC-style: reply is delivered via the response queue configured above
const response = await firstValueFrom(
  client.send({ cmd: 'order-persistence' }, message),
);

await client.close();
```

When a `responseQueue` is configured the transporter automatically attaches
`reply` metadata so `.send()` calls can receive data emitted by the matching
`@MessagePattern()` handler. Without a response queue the `.send()` observable
will resolve with the raw `SendMessageCommandOutput` result from AWS SQS.

For FIFO queues you can either supply `groupId`/`deduplicationId` per message
or set `defaultGroupId` / `defaultDeduplicationId` on the queue configuration.
Message attributes you pass are merged with the ones required by the transport
(`nestjs_correlation_id`, `nestjs_packet_type`, etc.).

## Environment variables

Provide AWS credentials so the SDK can authenticate. The most common setup is to export the following variables (any non-empty values work when targeting LocalStack):

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`

You can also rely on any other credential provider that the AWS SDK v3 supports (for example profiles or IAM roles).

For each queue the transport should poll, define a `queueKey` (for example `ORDER_PERSISTENCE_QUEUE`) and set either:

- `${queueKey}_URL` — full queue URL, or
- `${queueKey}_NAME` together with `AWS_ENDPOINT_URL` (and optionally `AWS_ACCOUNT_ID`) so the helper can derive the URL.

Global behaviour is controlled through optional environment variables:

| Variable                 | Description                                   | Default        |
| ------------------------ | --------------------------------------------- | -------------- |
| `AWS_REGION`             | Region passed into `SQSClient`                | `us-east-1`    |
| `AWS_ENDPOINT_URL`       | Override SQS endpoint (useful for LocalStack) | –              |
| `AWS_ACCOUNT_ID`         | Account portion when composing queue URLs     | `000000000000` |
| `SQS_MAX_MESSAGES`       | Maximum messages per poll                     | `5`            |
| `SQS_WAIT_TIME_SECONDS`  | Long polling wait time                        | `20`           |
| `SQS_VISIBILITY_TIMEOUT` | Visibility timeout after each poll            | `60`           |
| `SQS_ERROR_BACKOFF_MS`   | Delay before retrying after a poll failure    | `1000`         |

Per-queue overrides are available via `batchSizeKey`, `waitTimeSecondsKey`, and `visibilityTimeoutKey` in the queue definition you pass to `buildSqsMicroserviceOptionsFromEnv`. You can also mark queues as FIFO with `isFifo` and provide defaults for `defaultGroupId`, `defaultDeduplicationId`, and `defaultDelaySeconds` that the client will reuse when sending messages.
