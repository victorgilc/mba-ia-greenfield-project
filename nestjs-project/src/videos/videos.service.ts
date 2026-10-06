import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Video } from './entities/video.entity';
import { Channel } from '../channels/entities/channel.entity';
import { StorageService } from '../storage/storage.service';
import { VideoStatus } from './enums/video-status.enum';
import { nanoid } from 'nanoid';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { CreateDraftDto } from './dto/create-draft.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { VideoSizeExceededException } from '../common/exceptions/domain.exception';
import {
  MAX_VIDEO_SIZE_BYTES,
  MIN_S3_PART_SIZE_BYTES,
} from './videos.constants';

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    @InjectRepository(Channel)
    private readonly channelRepository: Repository<Channel>,
    private readonly storageService: StorageService,
    @InjectQueue('video-processing')
    private readonly videoProcessingQueue: Queue,
  ) {}

  async createDraft(userId: string, data: CreateDraftDto) {
    const channel = await this.channelRepository.findOne({
      where: { user_id: userId },
    });
    if (!channel) {
      throw new NotFoundException('Channel not found for this user');
    }

    const nanoId = nanoid();
    // Use an extension based on content-type if desired, but .mp4 is a generic default
    const fileKey = `videos/${channel.id}/${nanoId}.mp4`;

    const video = this.videoRepository.create({
      nano_id: nanoId,
      title: data.title || null,
      description: data.description || null,
      status: VideoStatus.DRAFT,
      channel_id: channel.id,
      file_key: fileKey,
    });

    await this.videoRepository.save(video);
    return video;
  }

  async initiateUpload(
    nanoId: string,
    userId: string,
    data: InitiateUploadDto,
  ) {
    const channel = await this.channelRepository.findOne({
      where: { user_id: userId },
    });
    if (!channel) throw new NotFoundException('Channel not found');

    const video = await this.videoRepository.findOne({
      where: { nano_id: nanoId, channel_id: channel.id },
    });
    if (!video)
      throw new NotFoundException('Video not found or you are not the owner');
    if (video.status !== VideoStatus.DRAFT) {
      throw new BadRequestException(
        'Upload already initiated or completed for this video',
      );
    }

    if (!video.file_key) {
      throw new BadRequestException('Video file key is missing');
    }

    if (data.size > MAX_VIDEO_SIZE_BYTES) {
      throw new VideoSizeExceededException(MAX_VIDEO_SIZE_BYTES);
    }

    const maxAllowedParts = Math.ceil(data.size / MIN_S3_PART_SIZE_BYTES);
    if (data.parts > maxAllowedParts) {
      throw new BadRequestException(
        `Number of parts (${data.parts}) exceeds maximum possible for file size of ${data.size} bytes (minimum 5MB per part, maximum ${maxAllowedParts} parts allowed)`,
      );
    }

    const uploadId = await this.storageService.createMultipartUpload(
      video.file_key,
      data.contentType,
    );
    const preSignedUrls = await this.storageService.getMultipartPreSignedUrls(
      video.file_key,
      uploadId,
      data.parts,
    );

    return { uploadId, preSignedUrls };
  }

  async completeUpload(
    nanoId: string,
    userId: string,
    data: CompleteUploadDto,
  ) {
    const channel = await this.channelRepository.findOne({
      where: { user_id: userId },
    });
    if (!channel) throw new NotFoundException('Channel not found');

    const video = await this.videoRepository.findOne({
      where: { nano_id: nanoId, channel_id: channel.id },
    });
    if (!video) throw new NotFoundException('Video not found');
    if (video.status !== VideoStatus.DRAFT) {
      throw new BadRequestException('Video is not in DRAFT status');
    }

    if (!video.file_key) {
      throw new BadRequestException('Video file key is missing');
    }

    // complete multipart
    await this.storageService.completeMultipartUpload(
      video.file_key,
      data.uploadId,
      data.parts,
    );

    // Authoritative size validation directly against S3/MinIO metadata
    const metadata = await this.storageService.getObjectMetadata(
      video.file_key,
    );
    if (metadata.contentLength > MAX_VIDEO_SIZE_BYTES) {
      await this.storageService.deleteObject(video.file_key);
      video.status = VideoStatus.FAILED;
      await this.videoRepository.save(video);
      throw new VideoSizeExceededException(MAX_VIDEO_SIZE_BYTES);
    }

    // change status to UPLOADED
    video.status = VideoStatus.UPLOADED;
    await this.videoRepository.save(video);

    // emit job to bullmq
    await this.videoProcessingQueue.add('process-video', {
      videoId: video.id,
      nanoId: video.nano_id,
      fileKey: video.file_key,
    });

    return video;
  }

  async getVideoForStreaming(nanoId: string) {
    const video = await this.videoRepository.findOne({
      where: { nano_id: nanoId },
      relations: ['channel'],
    });

    if (!video || video.status !== VideoStatus.READY) {
      throw new NotFoundException('Video not found or not ready');
    }

    const videoUrl = await this.storageService.getDownloadPresignedUrl(
      video.file_key!,
      3600 * 12,
    ); // valid for 12 hours
    const thumbnailUrl = video.thumbnail_key
      ? this.storageService.getPublicUrl(video.thumbnail_key)
      : null;

    return {
      id: video.nano_id,
      title: video.title,
      description: video.description,
      duration: video.duration_seconds,
      channel: {
        id: video.channel.id,
        name: video.channel.name,
        nickname: video.channel.nickname,
      },
      videoUrl,
      thumbnailUrl,
      createdAt: video.created_at,
    };
  }
}
