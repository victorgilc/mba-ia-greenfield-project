import { Test, TestingModule } from '@nestjs/testing';
import { VideosService } from './videos.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Video } from './entities/video.entity';
import { Channel } from '../channels/entities/channel.entity';
import { StorageService } from '../storage/storage.service';
import { getQueueToken } from '@nestjs/bullmq';
import { VideoStatus } from './enums/video-status.enum';
import { VideoSizeExceededException } from '../common/exceptions/domain.exception';
import { BadRequestException } from '@nestjs/common';

describe('VideosService', () => {
  let service: VideosService;

  const mockVideoRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
  };

  const mockChannelRepository = {
    findOne: jest.fn(),
  };

  const mockStorageService = {
    createMultipartUpload: jest.fn(),
    getMultipartPreSignedUrls: jest.fn(),
    completeMultipartUpload: jest.fn(),
    getDownloadPresignedUrl: jest.fn(),
    getPublicUrl: jest.fn(),
    getObjectMetadata: jest.fn(),
    deleteObject: jest.fn(),
  };

  const mockQueue = {
    add: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideosService,
        {
          provide: getRepositoryToken(Video),
          useValue: mockVideoRepository,
        },
        {
          provide: getRepositoryToken(Channel),
          useValue: mockChannelRepository,
        },
        {
          provide: StorageService,
          useValue: mockStorageService,
        },
        {
          provide: getQueueToken('video-processing'),
          useValue: mockQueue,
        },
      ],
    }).compile();

    service = module.get<VideosService>(VideosService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('initiateUpload', () => {
    it('should throw if channel not found', async () => {
      mockChannelRepository.findOne.mockResolvedValue(null);
      await expect(
        service.initiateUpload('nano1', 'user1', {
          contentType: 'video/mp4',
          parts: 2,
          size: 10485760,
        }),
      ).rejects.toThrow();
    });

    it('should throw VideoSizeExceededException if declared size exceeds 10GB', async () => {
      mockChannelRepository.findOne.mockResolvedValue({ id: 'channel1' });
      mockVideoRepository.findOne.mockResolvedValue({
        nano_id: 'nano1',
        id: 'vid1',
        file_key: 'key1',
        status: VideoStatus.DRAFT,
      });

      await expect(
        service.initiateUpload('nano1', 'user1', {
          contentType: 'video/mp4',
          parts: 1,
          size: 10 * 1024 * 1024 * 1024 + 1,
        }),
      ).rejects.toThrow(VideoSizeExceededException);
    });

    it('should throw BadRequestException if parts count exceeds allowed for size', async () => {
      mockChannelRepository.findOne.mockResolvedValue({ id: 'channel1' });
      mockVideoRepository.findOne.mockResolvedValue({
        nano_id: 'nano1',
        id: 'vid1',
        file_key: 'key1',
        status: VideoStatus.DRAFT,
      });

      // 4MB file cannot have 2 parts because each part must be at least 5MB
      await expect(
        service.initiateUpload('nano1', 'user1', {
          contentType: 'video/mp4',
          parts: 2,
          size: 4 * 1024 * 1024,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should create video and upload id', async () => {
      mockChannelRepository.findOne.mockResolvedValue({ id: 'channel1' });
      mockStorageService.createMultipartUpload.mockResolvedValue('uploadId1');
      mockVideoRepository.findOne.mockResolvedValue({
        nano_id: 'nano1',
        id: 'vid1',
        file_key: 'key1',
        status: VideoStatus.DRAFT,
      });
      mockStorageService.getMultipartPreSignedUrls.mockResolvedValue([
        'url1',
        'url2',
      ]);

      const res = await service.initiateUpload('nano1', 'user1', {
        contentType: 'video/mp4',
        parts: 2,
        size: 10485760,
      });

      expect(res.uploadId).toBe('uploadId1');
      expect(res.preSignedUrls).toHaveLength(2);
    });
  });

  describe('completeUpload', () => {
    it('should complete upload and enqueue job when size is valid', async () => {
      const mockVideo = {
        id: 'vid1',
        nano_id: 'nano1',
        file_key: 'key1',
        status: VideoStatus.DRAFT,
        channel_id: 'channel1',
      };
      mockChannelRepository.findOne.mockResolvedValue({ id: 'channel1' });
      mockVideoRepository.findOne.mockResolvedValue(mockVideo);
      mockStorageService.completeMultipartUpload.mockResolvedValue(undefined);
      mockStorageService.getObjectMetadata.mockResolvedValue({
        contentLength: 10485760,
      });
      mockVideoRepository.save.mockResolvedValue({
        ...mockVideo,
        status: VideoStatus.UPLOADED,
      });

      const res = await service.completeUpload('nano1', 'user1', {
        uploadId: 'up1',
        parts: [{ ETag: 'e1', PartNumber: 1 }],
      });

      expect(res.status).toBe(VideoStatus.UPLOADED);
      expect(mockQueue.add).toHaveBeenCalled();
    });

    it('should delete object, set status FAILED, and throw VideoSizeExceededException if storage size exceeds 10GB', async () => {
      const mockVideo = {
        id: 'vid1',
        nano_id: 'nano1',
        file_key: 'key1',
        status: VideoStatus.DRAFT,
        channel_id: 'channel1',
      };
      mockChannelRepository.findOne.mockResolvedValue({ id: 'channel1' });
      mockVideoRepository.findOne.mockResolvedValue(mockVideo);
      mockStorageService.completeMultipartUpload.mockResolvedValue(undefined);
      mockStorageService.getObjectMetadata.mockResolvedValue({
        contentLength: 10 * 1024 * 1024 * 1024 + 100,
      });
      mockStorageService.deleteObject.mockResolvedValue(undefined);

      await expect(
        service.completeUpload('nano1', 'user1', {
          uploadId: 'up1',
          parts: [{ ETag: 'e1', PartNumber: 1 }],
        }),
      ).rejects.toThrow(VideoSizeExceededException);

      expect(mockStorageService.deleteObject).toHaveBeenCalledWith('key1');
      expect(mockVideo.status).toBe(VideoStatus.FAILED);
      expect(mockVideoRepository.save).toHaveBeenCalledWith(mockVideo);
      expect(mockQueue.add).not.toHaveBeenCalled();
    });
  });

  describe('getVideoForStreaming', () => {
    it('should return urls', async () => {
      mockVideoRepository.findOne.mockResolvedValue({
        nano_id: 'nano1',
        status: VideoStatus.READY,
        file_key: 'key',
        thumbnail_key: 'thumb',
        channel: { id: 'ch1', name: 'N', nickname: 'n' },
      });
      mockStorageService.getDownloadPresignedUrl.mockResolvedValue('presigned');
      mockStorageService.getPublicUrl.mockReturnValue('pubUrl');

      const res = await service.getVideoForStreaming('nano1');
      expect(res.videoUrl).toBe('presigned');
      expect(res.thumbnailUrl).toBe('pubUrl');
    });
  });
});
