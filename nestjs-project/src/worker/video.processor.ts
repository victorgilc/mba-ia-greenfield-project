import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs/promises';
import * as path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { Video } from '../videos/entities/video.entity';
import { StorageService } from '../storage/storage.service';
import { VideoStatus } from '../videos/enums/video-status.enum';

interface ProcessVideoJobData {
  videoId: string;
  nanoId: string;
  fileKey: string;
}

@Processor('video-processing')
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData, void, string>): Promise<void> {
    const { videoId, nanoId, fileKey } = job.data;
    this.logger.log(`Processing video ${videoId}...`);

    try {
      const video = await this.videoRepository.findOne({
        where: { id: videoId },
      });
      if (!video) throw new Error('Video not found');

      video.status = VideoStatus.PROCESSING;
      await this.videoRepository.save(video);

      const downloadUrl = await this.storageService.getDownloadPresignedUrl(
        fileKey,
        3600,
      );

      const durationSeconds = await this.getVideoDuration(downloadUrl);
      const thumbnailKey = await this.generateThumbnail(
        downloadUrl,
        nanoId,
        video.channel_id,
      );

      video.duration_seconds = durationSeconds;
      video.thumbnail_key = thumbnailKey;
      video.status = VideoStatus.READY;
      await this.videoRepository.save(video);

      this.logger.log(`Successfully processed video ${videoId}`);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error processing video ${videoId}: ${msg}`);
      await this.videoRepository.update(videoId, {
        status: VideoStatus.FAILED,
      });
      throw error;
    }
  }

  private getVideoDuration(url: string): Promise<number> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(url, (err, metadata) => {
        if (err)
          return reject(err instanceof Error ? err : new Error(String(err)));
        resolve(Math.round(metadata.format?.duration || 0));
      });
    });
  }

  private generateThumbnail(
    url: string,
    nanoId: string,
    channelId: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      // In Docker environments like node/alpine, /tmp is available and writable
      const tmpDir = '/tmp';
      const filename = `${nanoId}.jpg`;
      const thumbnailKey = `thumbnails/${channelId}/${nanoId}.jpg`;

      ffmpeg(url)
        .on('end', () => {
          fs.readFile(path.join(tmpDir, filename))
            .then((buffer) =>
              this.storageService.uploadFile(
                thumbnailKey,
                buffer,
                'image/jpeg',
              ),
            )
            .then(() => fs.unlink(path.join(tmpDir, filename))) // cleanup
            .then(() => resolve(thumbnailKey))
            .catch((err) =>
              reject(err instanceof Error ? err : new Error(String(err))),
            );
        })
        .on('error', (err: unknown) => {
          reject(err instanceof Error ? err : new Error(String(err)));
        })
        .screenshots({
          count: 1,
          folder: tmpDir,
          filename: filename,
          size: '1280x720',
        });
    });
  }
}
