---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-10-01T19:28:47-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-01T19:28:24-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Implementar o ciclo de vida completo de um vídeo (upload, processamento e disponibilização). Isso inclui a geração de Pre-Signed URLs (para uploads diretos de até 10GB sem sobrecarregar a API), processamento em background (usando Redis + BullMQ e FFmpeg em um worker standalone) para extração de duração e thumbnail, e geração de IDs únicos (NanoID) para streaming e download.

---

## Step Implementations

### SI-03.1 — Configuração do Storage (MinIO/S3) e Infraestrutura
**Description:** Preparar o `compose.yaml` com o MinIO (para simular S3 localmente), configurar buckets, IAM simulado/policies se necessário, e criar o `StorageModule` na API usando `@aws-sdk/client-s3`.

### SI-03.2 — Estrutura Base do Módulo de Vídeos e Entidade
**Description:** Criar a entidade `Video` (com ciclo de vida Enum: DRAFT, UPLOADED, PROCESSING, READY, FAILED) e associá-la à entidade `Channel`. Configurar o módulo `VideosModule` com controllers e services base usando NanoID.

### SI-03.3 — Fila e BullMQ na API
**Description:** Adicionar serviço Redis ao `compose.yaml`, instalar e configurar `@nestjs/bullmq`, injetar a fila de processamento (`video-processing`) na API para enfileirar jobs quando um vídeo for marcado como `UPLOADED`.

### SI-03.4 — Upload via Pre-Signed URLs
**Description:** Implementar endpoints no `VideosController` para criar rascunhos (DRAFT), obter Pre-Signed URLs de multipart upload, e um endpoint para confirmar a conclusão do upload (mudando para UPLOADED e despachando job na fila).

### SI-03.5 — Worker Standalone de Processamento de Vídeo
**Description:** Criar o serviço `video-worker` no monorepo (aplicativo NestJS Standalone) com FFmpeg instalado no Dockerfile. Configurar um processor do BullMQ para escutar a fila `video-processing`.

### SI-03.6 — Processamento com FFmpeg e Thumbnails
**Description:** Implementar a lógica no worker para baixar (via S3 SDK ou URL pre-signed), processar (usando `fluent-ffmpeg` para pegar duração e gerar um frame), re-enviar os metadados e atualizar a entidade `Video` para `READY` ou `FAILED`.

### SI-03.7 — Streaming e Leitura do Vídeo
**Description:** Implementar endpoint para obter os detalhes do vídeo (apenas vídeos READY podem ser listados/reproduzidos) com URL de leitura baseada no NanoID gerada pelo serviço de Storage (pre-signed de leitura com TTL configurado).

---

## Dependency Map

```
SI-03.1
├── SI-03.2
│   ├── SI-03.3
│   │   ├── SI-03.4
│   │   └── SI-03.5
│   │       └── SI-03.6
│   └── SI-03.7
```

## Deliverables

- [x] MinIO rodando via Docker Compose.
- [x] Redis rodando via Docker Compose.
- [x] `VideosModule` funcional, entidades atualizadas.
- [x] API gera Pre-Signed URLs para Multipart Upload de 10GB.
- [x] API confirma o upload e emite Job no Redis.
- [x] Worker NestJS processa o vídeo com FFmpeg (duração e thumbnail).
- [x] Endpoints para listagem e acesso a streaming/download usando NanoID publicamente.
- [x] Testes unitários e de integração/E2E cobrindo o fluxo principal e worker.
