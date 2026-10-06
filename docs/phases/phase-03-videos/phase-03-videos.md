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

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | UUID interno do sistema |
| nano_id | varchar(21) | unique, not null | Identificador público URL-safe (NanoID) |
| title | varchar(255) | nullable | Título inicial do vídeo |
| description | text | nullable | Descrição opcional |
| status | enum | not null, default: `'DRAFT'` | `DRAFT`, `UPLOADED`, `PROCESSING`, `READY`, `FAILED` |
| file_key | varchar(500) | nullable | Chave do arquivo de vídeo no S3/MinIO (`videos/<channel_id>/<nano_id>.mp4`) |
| thumbnail_key | varchar(500) | nullable | Chave da thumbnail no S3/MinIO (`thumbnails/<channel_id>/<nano_id>.jpg`) |
| duration_seconds | integer | nullable | Duração do vídeo extraída via FFprobe |
| channel_id | uuid | FK → channels.id, not null | Canal proprietário do vídeo |
| created_at | timestamp | not null, auto-generated | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto-generated | `@UpdateDateColumn` |

**Relations:**
- `Video` → `Channel` (`@ManyToOne(() => Channel, channel => channel.videos, { onDelete: 'CASCADE' })`)
- `Channel` → `Video` (`@OneToMany(() => Video, video => video.channel)`)

**Indexes:**
- `(nano_id)` — UNIQUE
- `(channel_id)` — FK

---

### API Contracts

#### POST /videos (SI-03.4)
Cria um pré-cadastro (Draft) do vídeo antes de iniciar a transferência dos bytes.

**Request headers:**
- `Authorization`: `Bearer <access_token>`
- `Content-Type`: `application/json`

**Request body:**
```json
{
  "title": "Título do Vídeo (opcional)",
  "description": "Descrição do Vídeo (opcional)"
}
```

**Response 201 Created:**
```json
{
  "id": "uuid",
  "nano_id": "V1StGXR8_Z5jdHi6B-myT",
  "title": "Título do Vídeo",
  "description": "Descrição do Vídeo",
  "status": "DRAFT",
  "file_key": "videos/<channel_id>/<nano_id>.mp4",
  "thumbnail_key": null,
  "duration_seconds": null,
  "channel_id": "uuid",
  "created_at": "timestamp",
  "updated_at": "timestamp"
}
```

**Error responses:**
- `401 UNAUTHORIZED`: Token de autenticação ausente ou inválido
- `404 NOT_FOUND`: Canal não encontrado para o usuário autenticado

---

#### POST /videos/:nanoId/upload/initiate (SI-03.4)
Gera o UploadId multipart no S3/MinIO e o lote de Pre-Signed URLs para envio direto dos blocos pelo cliente.

**Request headers:**
- `Authorization`: `Bearer <access_token>`
- `Content-Type`: `application/json`

**Request body:**
```json
{
  "contentType": "video/mp4",
  "size": 8589934592,
  "parts": 16
}
```

**Response 200 OK:**
```json
{
  "uploadId": "string",
  "preSignedUrls": [
    {
      "partNumber": 1,
      "url": "http://minio:9000/streamtube/videos/...?partNumber=1&uploadId=...&X-Amz-..."
    }
  ]
}
```

**Error responses:**
- `400 BAD_REQUEST`: Número de partes incompatível com a regra do S3 (mínimo 5MB por parte) ou parâmetros ausentes
- `401 UNAUTHORIZED`: Usuário não autenticado
- `404 NOT_FOUND`: Vídeo não encontrado ou usuário não é o dono do vídeo
- `413 VIDEO_SIZE_EXCEEDED`: Tamanho declarado excede o teto máximo de 10GB (10.737.418.240 bytes)

---

#### POST /videos/:nanoId/upload/complete (SI-03.4)
Consolida o multipart upload no S3/MinIO, atualiza o status para `UPLOADED` e enfileira o job para processamento no BullMQ.

**Request headers:**
- `Authorization`: `Bearer <access_token>`
- `Content-Type`: `application/json`

**Request body:**
```json
{
  "uploadId": "string",
  "parts": [
    {
      "ETag": "\"etag-da-parte-1\"",
      "PartNumber": 1
    }
  ]
}
```

**Response 200 OK:**
```json
{
  "id": "uuid",
  "nano_id": "V1StGXR8_Z5jdHi6B-myT",
  "status": "UPLOADED"
}
```

**Error responses:**
- `400 BAD_REQUEST`: Vídeo não está em status DRAFT ou chave do arquivo ausente
- `401 UNAUTHORIZED`: Usuário não autenticado
- `404 NOT_FOUND`: Vídeo não encontrado
- `413 VIDEO_SIZE_EXCEEDED`: O tamanho real consolidado no S3 excede 10GB

---

#### GET /videos/:nanoId (SI-03.7)
Retorna os metadados do vídeo e a URL pré-assinada para streaming e download direto. Acesso público.

**Request headers:**
- Nenhuma autenticação exigida (Endpoint público)

**Response 200 OK:**
```json
{
  "id": "V1StGXR8_Z5jdHi6B-myT",
  "title": "Título do Vídeo",
  "description": "Descrição do Vídeo",
  "duration": 120,
  "channel": {
    "id": "uuid",
    "name": "Nome do Canal",
    "nickname": "nickname_canal"
  },
  "videoUrl": "http://minio:9000/streamtube/videos/...?X-Amz-...",
  "thumbnailUrl": "http://minio:9000/streamtube/thumbnails/....jpg",
  "createdAt": "timestamp"
}
```

**Error responses:**
- `404 NOT_FOUND`: Vídeo não existe ou seu status ainda não é `READY` (ex: ainda processando em segundo plano)

---

### Authorization Matrix

| Endpoint | Público | Autenticado | Dono do Recurso | Descrição |
|----------|:-------:|:-----------:|:---------------:|-----------|
| `POST /videos` | | ✓ | | Criação de rascunho de vídeo associado ao canal do usuário |
| `POST /videos/:nanoId/upload/initiate` | | ✓ | ✓ | Inicia upload multipart e gera pre-signed URLs |
| `POST /videos/:nanoId/upload/complete` | | ✓ | ✓ | Conclui upload e enfileira job de processamento |
| `GET /videos/:nanoId` | ✓ | | | Acesso anônimo a vídeos em status `READY` para streaming e download |

---

### Error Catalog

| Código de Erro | HTTP Status | Causa |
|----------------|-------------|-------|
| `VIDEO_SIZE_EXCEEDED` | 413 Payload Too Large | Arquivo excede o limite máximo permitido de 10GB (`10.737.418.240` bytes) |
| `NOT_FOUND` | 404 Not Found | Recurso (vídeo, canal) não encontrado ou vídeo não está pronto (`status !== READY`) |
| `BAD_REQUEST` | 400 Bad Request | Payload inválido, contagem de partes inválida ou transição de status incorreta |
| `UNAUTHORIZED` | 401 Unauthorized | Token JWT ausente, expirado ou inválido |

---

### Events / Messages (BullMQ Job Queue)

- **Fila:** `video-processing`
- **Job Name:** `process-video`
- **Job Payload:**
  ```json
  {
    "videoId": "uuid",
    "nanoId": "V1StGXR8_Z5jdHi6B-myT",
    "fileKey": "videos/<channel_id>/<nano_id>.mp4"
  }
  ```
- **Consumer:** `VideoProcessor` executando no container dedicado `video-worker`.
- **Ciclo de Processamento:**
  1. O worker recebe o job e atualiza o status do vídeo para `PROCESSING`.
  2. Baixa o vídeo do MinIO em streaming temporário.
  3. Executa `ffprobe` (via `fluent-ffmpeg`) para extrair metadados e duração exata em segundos.
  4. Executa `ffmpeg` para gerar thumbnail JPEG a partir de frame (a 1 segundo ou ponto médio).
  5. Faz o upload da thumbnail para `thumbnails/<channel_id>/<nano_id>.jpg` no S3/MinIO.
  6. Atualiza a entidade `Video` no PostgreSQL com `duration_seconds`, `thumbnail_key` e status `READY`.
  7. Em caso de falha irreversível, captura exceção e atualiza o status para `FAILED`.

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
