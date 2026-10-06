---
libs:
  "@nestjs/bullmq":
    version: "^11.0.0"
  "bullmq":
    version: "^5.0.0"
  "@aws-sdk/client-s3":
    version: "^3.0.0"
  "@aws-sdk/s3-request-presigner":
    version: "^3.0.0"
  "fluent-ffmpeg":
    version: "^2.1.0"
  "@types/fluent-ffmpeg":
    version: "^2.1.0"
  "nanoid":
    version: "^3.0.0"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-01T19:28:24-03:00"
---

# Library References

### @nestjs/bullmq & bullmq
- **Usage:** Job Queue, worker configuration, message broker integration.
- **Config:** `BullModule.forRoot()` com Redis.

### @aws-sdk/client-s3 & @aws-sdk/s3-request-presigner
- **Usage:** Gerar Pre-Signed URLs para upload multipart e streaming de leitura, listagem e remoção de objetos.

### fluent-ffmpeg
- **Usage:** Wrapper para o CLI do ffmpeg. Usado no Worker para extrair metadata (duração) e gerar thumbnails.

### nanoid
- **Usage:** Geração rápida e URL-friendly de identificadores únicos para os vídeos.
