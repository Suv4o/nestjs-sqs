import { MessagePattern } from '@nestjs/microservices';
import type { SqsPattern } from './sqs.types.js';

export const sqsPattern = (queueName: string): SqsPattern => ({
  cmd: queueName,
});

export const SqsMessagePattern = (queueName: string): MethodDecorator => {
  const pattern = sqsPattern(queueName);
  return (target, propertyKey, descriptor) =>
    MessagePattern(pattern)(target, propertyKey, descriptor);
};
