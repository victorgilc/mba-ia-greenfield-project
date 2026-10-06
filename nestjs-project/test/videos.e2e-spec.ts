import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import type { Server } from 'node:http';
import { AppModule } from './../src/app.module';
import { DataSource } from 'typeorm';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';

interface IdRow {
  id: string;
}

interface LoginResponseBody {
  access_token: string;
}

interface DraftResponseBody {
  nano_id: string;
}

interface InitiateUploadResponseBody {
  uploadId: string;
  preSignedUrls: string[];
}

interface ErrorResponseBody {
  message: string[] | string;
}

describe('VideosController (e2e)', () => {
  let app: INestApplication;
  let server: Server;
  let dataSource: DataSource;
  let accessToken: string;
  let nanoId: string;

  const cleanupUser = async () => {
    try {
      const users = await dataSource.query<IdRow[]>(
        `SELECT id FROM users WHERE email = 'videotest@example.com'`,
      );
      if (users && users.length > 0) {
        const userId = users[0].id;
        const channels = await dataSource.query<IdRow[]>(
          `SELECT id FROM channels WHERE user_id = $1`,
          [userId],
        );
        for (const ch of channels) {
          await dataSource.query(`DELETE FROM videos WHERE channel_id = $1`, [
            ch.id,
          ]);
        }
        await dataSource.query(`DELETE FROM channels WHERE user_id = $1`, [
          userId,
        ]);
        await dataSource.query(
          `DELETE FROM verification_tokens WHERE user_id = $1`,
          [userId],
        );
        await dataSource.query(
          `DELETE FROM refresh_tokens WHERE user_id = $1`,
          [userId],
        );
        await dataSource.query(`DELETE FROM users WHERE id = $1`, [userId]);
      }
    } catch {
      // ignore cleanup error
    }
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    server = app.getHttpServer() as Server;
    dataSource = app.get(DataSource);

    await cleanupUser();
  });

  afterAll(async () => {
    await cleanupUser();
    await app.close();
  });

  it('should register a test user, confirm email, login, and create draft video without contentType', async () => {
    // 1. Register user
    await request(server)
      .post('/auth/register')
      .send({ email: 'videotest@example.com', password: 'password123' })
      .expect(201);

    // 2. Confirm email
    await dataSource.query(
      `UPDATE users SET is_confirmed = true WHERE email = 'videotest@example.com'`,
    );

    // 3. Login
    const loginRes = await request(server)
      .post('/auth/login')
      .send({ email: 'videotest@example.com', password: 'password123' })
      .expect(200);

    const loginBody = loginRes.body as LoginResponseBody;
    accessToken = loginBody.access_token;
    expect(accessToken).toBeDefined();

    // 4. Create Draft Video without contentType (regression test for validation error)
    const draftRes = await request(server)
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        title: 'Test Video',
        description: 'Testing draft creation',
      })
      .expect(201);

    const draftBody = draftRes.body as DraftResponseBody;
    expect(draftBody).toHaveProperty('nano_id');
    nanoId = draftBody.nano_id;
  });

  it('should initiate upload', async () => {
    const res = await request(server)
      .post(`/videos/${nanoId}/upload/initiate`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        contentType: 'video/mp4',
        parts: 1,
        size: 10485760,
      })
      .expect(200);

    const body = res.body as InitiateUploadResponseBody;
    expect(body).toHaveProperty('uploadId');
    expect(body).toHaveProperty('preSignedUrls');
    expect(Array.isArray(body.preSignedUrls)).toBe(true);
  });

  it('should reject initiate upload with 413 if declared size exceeds 10GB', async () => {
    // 10GB + 1 byte = 10737418241
    const res = await request(server)
      .post(`/videos/${nanoId}/upload/initiate`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        contentType: 'video/mp4',
        parts: 1,
        size: 10737418241,
      })
      .expect(413);

    expect(res.body).toHaveProperty('error', 'VIDEO_SIZE_EXCEEDED');
    expect(res.body).toHaveProperty('statusCode', 413);
  });

  it('should reject initiate upload with 400 if parts exceeds maximum allowed for size', async () => {
    // 4MB file cannot have 2 parts because each part must be at least 5MB
    const res = await request(server)
      .post(`/videos/${nanoId}/upload/initiate`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        contentType: 'video/mp4',
        parts: 2,
        size: 4194304,
      })
      .expect(400);

    const body = res.body as ErrorResponseBody;
    const messageStr = Array.isArray(body.message)
      ? body.message.join(' ')
      : body.message;
    expect(messageStr).toContain('exceeds maximum possible for file size');
  });

  it('should reject initiate upload with 400 if unknown property like partsCount is sent', async () => {
    const res = await request(server)
      .post(`/videos/${nanoId}/upload/initiate`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        contentType: 'video/mp4',
        parts: 1,
        size: 10485760,
        partsCount: 1,
      })
      .expect(400);

    const body = res.body as ErrorResponseBody;
    expect(body.message).toContain('property partsCount should not exist');
  });

  it('should fail initiate upload with 400 when contentType is missing', async () => {
    const res = await request(server)
      .post(`/videos/${nanoId}/upload/initiate`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        parts: 1,
        size: 10485760,
      })
      .expect(400);

    const body = res.body as ErrorResponseBody;
    expect(body.message).toContain('contentType should not be empty');
  });

  it('should fail initiate upload with 400 when size is missing', async () => {
    const res = await request(server)
      .post(`/videos/${nanoId}/upload/initiate`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        contentType: 'video/mp4',
        parts: 1,
      })
      .expect(400);

    const body = res.body as ErrorResponseBody;
    expect(body.message).toContain('size must be an integer number');
  });

  it('should allow creating a draft with empty body', async () => {
    const res = await request(server)
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({})
      .expect(201);

    const body = res.body as DraftResponseBody;
    expect(body).toHaveProperty('nano_id');
  });
});
