import {
  IsString,
  IsNotEmpty,
  IsArray,
  ValidateNested,
  IsInt,
} from 'class-validator';
import { Type } from 'class-transformer';

class UploadPartDto {
  @IsString()
  @IsNotEmpty()
  ETag: string;

  @IsInt()
  @IsNotEmpty()
  PartNumber: number;
}

export class CompleteUploadDto {
  @IsString()
  @IsNotEmpty()
  uploadId: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UploadPartDto)
  parts: UploadPartDto[];
}
