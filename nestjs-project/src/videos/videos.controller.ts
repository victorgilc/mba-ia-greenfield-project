import {
  Controller,
  Post,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
  Get,
} from '@nestjs/common';
import { VideosService } from './videos.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { CreateDraftDto } from './dto/create-draft.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';

@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  async createDraft(
    @CurrentUser() user: JwtPayload,
    @Body() data: CreateDraftDto,
  ) {
    return this.videosService.createDraft(user.sub, data);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':nanoId/upload/initiate')
  @HttpCode(HttpStatus.OK)
  async initiateUpload(
    @Param('nanoId') nanoId: string,
    @CurrentUser() user: JwtPayload,
    @Body() data: InitiateUploadDto,
  ) {
    return this.videosService.initiateUpload(nanoId, user.sub, data);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':nanoId/upload/complete')
  @HttpCode(HttpStatus.OK)
  async completeUpload(
    @Param('nanoId') nanoId: string,
    @CurrentUser() user: JwtPayload,
    @Body() data: CompleteUploadDto,
  ) {
    return this.videosService.completeUpload(nanoId, user.sub, data);
  }

  @Public()
  @Get(':nanoId')
  async getVideo(@Param('nanoId') nanoId: string) {
    return this.videosService.getVideoForStreaming(nanoId);
  }
}
