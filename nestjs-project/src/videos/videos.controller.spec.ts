import { Test, TestingModule } from '@nestjs/testing';
import { VideosController } from './videos.controller';
import { JwtService } from '@nestjs/jwt';
import { VideosService } from './videos.service';
import { JwtPayload } from '../auth/auth.types';

describe('VideosController', () => {
  let controller: VideosController;

  const mockVideosService = {
    initiateUpload: jest.fn(),
    completeUpload: jest.fn(),
    getVideoForStreaming: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [VideosController],
      providers: [
        {
          provide: VideosService,
          useValue: mockVideosService,
        },
        {
          provide: JwtService,
          useValue: { verifyAsync: jest.fn() },
        },
      ],
    }).compile();

    controller = module.get<VideosController>(VideosController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('should initiate upload', async () => {
    mockVideosService.initiateUpload.mockResolvedValue({
      uploadId: 'u',
      parts: [],
    });
    const res = await controller.initiateUpload(
      'nano1',
      { sub: 'user' } as unknown as JwtPayload,
      {
        contentType: 'video/mp4',
        parts: 2,
        size: 10485760,
      },
    );
    expect(res.uploadId).toBe('u');
  });

  it('should complete upload', async () => {
    mockVideosService.completeUpload.mockResolvedValue({
      status: 'PROCESSING',
    });
    const res = (await controller.completeUpload(
      'nano1',
      { sub: 'user' } as unknown as JwtPayload,
      { uploadId: 'u', parts: [] },
    )) as { status: string };
    expect(res.status).toBe('PROCESSING');
  });

  it('should get video', async () => {
    mockVideosService.getVideoForStreaming.mockResolvedValue({
      videoUrl: 'url',
    });
    const res = (await controller.getVideo('nano1')) as { videoUrl: string };
    expect(res.videoUrl).toBe('url');
  });
});
