# @suv4o/nestjs-sqs

`@suv4o/nestjs-sqs` is a transport strategy for NestJS that lets you process Amazon SQS messages with the familiar `@MessagePattern()` API. It also ships with a matching `ClientProxy`, so you can publish events or RPC-style commands without pulling in extra producer libraries.

## Links

- npm: <https://www.npmjs.com/package/@suv4o/nestjs-sqs>
- GitHub: <https://github.com/Suv4o/nestjs-sqs>

## Features

- ✅ Works with NestJS microservices (`CustomTransportStrategy`, `@MessagePattern`)
- ✅ First-party `.emit()` and `.send()` support via `SqsClient`
- ✅ Multi-queue polling with per-queue batch size, wait time, and visibility settings
- ✅ Helpers for deriving queue configuration from environment variables
- ✅ No runtime dependencies beyond AWS SDK v3 and NestJS peers

## Installation

```bash
npm install @suv4o/nestjs-sqs @aws-sdk/client-sqs
```

Make sure your project already depends on the NestJS microservice packages (`@nestjs/common`, `@nestjs/core`, `@nestjs/microservices`) and `rxjs`.

## Consume messages with a Nest microservice

1. **Define a pattern** for each queue you want to handle.

```ts
// orders.patterns.ts
import { sqsPattern } from '@suv4o/nestjs-sqs';

export const ORDER_CREATED_PATTERN = sqsPattern('order-created');
```

2. **Register handlers** using `@MessagePattern` (or `SqsMessagePattern`). The transport deserialises the payload for you, so handlers receive your DTO directly. If you need the raw SQS message, inject `SqsContext` as the second argument.

```ts
// orders.controller.ts
import { Controller } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import type { OrderCreatedEvent } from './orders.dto';
import { ORDER_CREATED_PATTERN } from './orders.patterns';
import { OrdersService } from './orders.service';

@Controller()
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @MessagePattern(ORDER_CREATED_PATTERN)
  async handleOrderCreated(event: OrderCreatedEvent): Promise<void> {
    await this.ordersService.createOrder(event);
  }
}
```

3. **Boot the microservice** using `SqsServer`. The helper `buildSqsMicroserviceOptionsFromEnv` reads queue URLs (or names + endpoint) straight from the environment.

```ts
// main.ts
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { SQSClient } from '@aws-sdk/client-sqs';
import {
  SqsServer,
  buildSqsMicroserviceOptionsFromEnv,
} from '@suv4o/nestjs-sqs';
import { OrdersModule } from './orders.module';
import { ORDER_CREATED_PATTERN } from './orders.patterns';

async function bootstrap(): Promise<void> {
  const sqsClient = new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.AWS_ENDPOINT_URL, // optional (e.g. LocalStack)
  });

  const options = buildSqsMicroserviceOptionsFromEnv([
    {
      pattern: ORDER_CREATED_PATTERN,
      queueKey: 'ORDER_CREATED_QUEUE',
      defaults: {
        batchSize: Number(process.env.ORDER_CREATED_BATCH_SIZE ?? 10),
        waitTimeSeconds: Number(process.env.ORDER_CREATED_WAIT_TIME ?? 20),
      },
    },
  ]);

  const app = await NestFactory.createMicroservice(OrdersModule, {
    strategy: new SqsServer(options, sqsClient),
  });

  await app.listen();
}

void bootstrap();
```

Environment variables expected by the snippet above:

- `ORDER_CREATED_QUEUE_URL` – full queue URL, **or**
- `ORDER_CREATED_QUEUE_NAME` + `AWS_ENDPOINT_URL` (handy for LocalStack)
- Optional overrides like `ORDER_CREATED_BATCH_SIZE` and `ORDER_CREATED_WAIT_TIME`

## Publish messages with the built-in client

The package includes a `ClientProxy` implementation so you can fan out events or use request/response patterns without third-party producers.

```ts
// sqs-client.provider.ts
import { ClientProxyFactory } from '@nestjs/microservices';
import { SQSClient } from '@aws-sdk/client-sqs';
import {
  SqsClient,
  type SqsClientOptions,
  sqsPattern,
} from '@suv4o/nestjs-sqs';

export const SQS_CLIENT = Symbol('SQS_CLIENT');

export const sqsClientProvider = {
  provide: SQS_CLIENT,
  useFactory: () => {
    const sqs = new SQSClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
    });

    return ClientProxyFactory.create({
      customClass: SqsClient,
      options: {
        client: sqs,
        queues: [
          {
            pattern: sqsPattern('order-created'),
            queueUrl: process.env.ORDER_CREATED_QUEUE_URL!,
            isFifo: process.env.ORDER_CREATED_QUEUE_URL?.endsWith('.fifo'),
          },
        ],
        responseQueue: process.env.ORDER_RESPONSES_QUEUE_URL
          ? {
              queueUrl: process.env.ORDER_RESPONSES_QUEUE_URL,
              waitTimeSeconds: 5,
            }
          : undefined,
      } satisfies SqsClientOptions,
    });
  },
};
```

Use the proxy anywhere you inject providers:

```ts
// orders.producer.ts
import { Injectable, Inject, OnModuleInit } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import type { OrderCreatedEvent } from './orders.dto';
import type { SqsOutboundMessage } from '@suv4o/nestjs-sqs';
import { SQS_CLIENT } from './sqs-client.provider';

@Injectable()
export class OrdersProducer implements OnModuleInit {
  constructor(@Inject(SQS_CLIENT) private readonly client: ClientProxy) {}

  async onModuleInit(): Promise<void> {
    await this.client.connect();
  }

  async emitOrderCreated(event: OrderCreatedEvent): Promise<void> {
    const payload: SqsOutboundMessage<OrderCreatedEvent> = {
      body: event,
      messageAttributes: {
        event_type: { DataType: 'String', StringValue: 'order.created' },
      },
      groupId: event.customerId, // optional (FIFO queues only)
      deduplicationId: event.orderId,
    };

    await firstValueFrom(this.client.emit({ cmd: 'order-created' }, payload));
  }

  async sendOrderCreated(event: OrderCreatedEvent): Promise<unknown> {
    const payload: SqsOutboundMessage<OrderCreatedEvent> = { body: event };
    return firstValueFrom(this.client.send({ cmd: 'order-created' }, payload));
  }
}
```

- `emit` is fire-and-forget.
- `send` waits for a response. When you configure `responseQueue`, the transport coordinates correlation IDs and packets automatically.

## Configuration tips

- **Queue discovery** – `buildSqsMicroserviceOptionsFromEnv` accepts an array of `{ pattern, queueKey }`. For each entry it looks for `QUEUE_KEY_URL` first, then `QUEUE_KEY_NAME` (combines it with `AWS_ENDPOINT_URL` and `AWS_ACCOUNT_ID`).
- **Polling behaviour** – Override defaults per queue with `defaults` in the helper or set `batchSize`, `waitTimeSeconds`, `visibilityTimeout`, `attributeNames`, and `messageAttributeNames` directly on each queue config.
- **FIFO queues** – supply `isFifo: true` and either populate `groupId`/`deduplicationId` per message or configure `defaultGroupId` / `defaultDeduplicationId` on the queue options.
- **Error handling** – set `deleteMessageOnSuccess` (default `true`) and `requeueOnError` (default `true`) when you need custom acknowledgement semantics.
- **Response queues** – add a `responseQueue` to `SqsClientOptions` to unlock NestJS RPC semantics (`client.send`) over SQS.
- **Logging** – pass a custom `logger` in `SqsClientOptions` or the `SqsServer` constructor to integrate with your existing logging tooling.

## Local development

Running against [LocalStack](https://docs.localstack.cloud/) or another SQS emulator becomes straightforward:

1. Point `AWS_ENDPOINT_URL` at the emulator endpoint.
2. Provide dummy credentials (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`).
3. Use `*_QUEUE_NAME` variables instead of full URLs so the helper can derive the correct local URL.

## Testing strategies

- **Unit test handlers** by calling service methods directly with fixture DTOs.
- **Integration test** with Nest’s testing module plus the in-memory transport: instantiate `SqsServer` with a mocked `SQSClient` (e.g., using `aws-sdk-client-mock`) and assert message handling logic.
- **Contract test producers** by asserting the shape of `SqsOutboundMessage` envelopes before they’re passed to `client.emit()`/`send()`.

## Additional resources

- Examples: <https://github.com/Suv4o/order-microservices>
- NestJS microservices docs: <https://docs.nestjs.com/microservices/basics>
- AWS SQS developer guide: <https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/welcome.html>

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
