import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker/worker.module';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  await app.init();
  const logger = new Logger('WorkerBootstrap');
  logger.log('Video Processing Worker is running...');
}
void bootstrap();
