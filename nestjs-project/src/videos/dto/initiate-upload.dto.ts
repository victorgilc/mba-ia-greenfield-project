import { IsString, IsInt, IsNotEmpty, Min, Max } from 'class-validator';

export class InitiateUploadDto {
  @IsString()
  @IsNotEmpty()
  contentType: string;

  @IsInt()
  @Min(1)
  size: number;

  @IsInt()
  @Min(1)
  @Max(10000)
  parts: number;
}
