import { IsString, IsOptional } from 'class-validator';

export class CreateDraftDto {
  @IsString()
  @IsOptional()
  title?: string;

  @IsString()
  @IsOptional()
  description?: string;
}
