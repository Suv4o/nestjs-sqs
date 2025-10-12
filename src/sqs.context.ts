import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { Message } from '@aws-sdk/client-sqs';

export class SqsContext {
  constructor(
    private readonly sqsClient: SQSClient,
    private readonly queueUrl: string,
    private readonly message: Message,
  ) {}

  getMessage(): Message {
    return this.message;
  }

  getQueueUrl(): string {
    return this.queueUrl;
  }

  async deleteMessage(): Promise<void> {
    if (!this.message.ReceiptHandle) {
      return;
    }
    await this.sqsClient.send(
      new DeleteMessageCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: this.message.ReceiptHandle,
      }),
    );
  }

  async changeVisibility(timeoutSeconds: number): Promise<void> {
    if (!this.message.ReceiptHandle) {
      return;
    }
    await this.sqsClient.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: this.message.ReceiptHandle,
        VisibilityTimeout: timeoutSeconds,
      }),
    );
  }
}
