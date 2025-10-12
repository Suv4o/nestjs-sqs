# @suv4o/nestjs-sqs

NestJS microservice transport strategy for AWS SQS that keeps the native `@MessagePattern()` workflow. Bring your own `SQSClient`, point the transport at one or more queues, and keep handling messages with standard Nest controllers.

## Features

- ✅ Native NestJS microservice API (`@MessagePattern`, `CustomTransportStrategy`)
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
import { SQSClient } from '@aws-sdk/client-sqs';
import {
  SqsServer,
  SqsMessagePattern,
  buildSqsMicroserviceOptionsFromEnv,
} from '@suv4o/nestjs-sqs';

@Controller()
class OrdersController {
  @SqsMessagePattern('order-persistence')
  async handleOrder(message: Message): Promise<void> {
    // …your business logic
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

Per-queue overrides are available via `batchSizeKey`, `waitTimeSecondsKey`, and `visibilityTimeoutKey` in the queue definition you pass to `buildSqsMicroserviceOptionsFromEnv`.
