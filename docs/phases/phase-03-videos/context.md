---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-10-01T19:28:47-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-01T19:28:24-03:00"
  docs/phases/phase-02-auth/context.md: "2026-10-01T19:28:32-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities**

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Frontend/Interface de upload, edição de dados do vídeo (Phase 04). Apenas API, Worker, Storage e Fila.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`, `compose.yaml`

**Deferred subprojects:** `next-frontend/` — telas de listagem, player, e tela de upload ficam diferidas para uma fase futura.

**Sequencing notes:** Depends on Fase 01 — Configuração Base do Projeto, Fase 02 — Cadastro, Login e Gerenciamento de Conta.

**Neighbors (for boundary detection only):**

- **Phase 02:** Cadastro, Login e Gerenciamento de Conta
- **Phase 04:** Gerenciamento de Vídeos e Canal

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Infraestrutura / Backend | Tecnologia de Fila de Mensagens | decided | A (Redis + BullMQ) | @nestjs/bullmq, bullmq |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Backend / Storage | Estratégia de Upload de Arquivos Grandes (10GB) | decided | B (Pre-Signed URLs Multipart Upload) | @aws-sdk/client-s3 |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend | Arquitetura do Worker de Vídeo | decided | B (Container de Worker Isolado) | fluent-ffmpeg |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend | Streaming de Vídeo e URL Única | decided | NanoID público + Pre-Signed URLs de Leitura (Option B) | nanoid |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Domain Model | Ciclo de Status do Vídeo | decided | Máquina de estados Enum (DRAFT, UPLOADED, PROCESSING, READY, FAILED) | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-02 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-05 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-03, phase-03-videos/TD-05 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-03 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-04 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-04 |
| Download do vídeo pelo usuário | phase-03-videos/TD-04 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** A (Redis + BullMQ) — É o padrão ouro no ecossistema NestJS para processamento de jobs (Job Queue). É mais fácil rastrear status, fazer retries e comunicar progresso. Redis é leve o suficiente para subir no Compose e atende perfeitamente ao caso de uso.
**Libraries:** @nestjs/bullmq, bullmq

### phase-03-videos/TD-02

**Recommendation:** B (Pre-Signed URLs com Multipart Upload) — Essencial para arquivos da ordem de gigabytes. É a única forma de atender ao requisito de "não travar a API durante o envio".
**Libraries:** @aws-sdk/client-s3

### phase-03-videos/TD-03

**Recommendation:** B (Container de Worker Isolado) — Rodar o FFmpeg num container apartado da API HTTP é uma prática obrigatória em sistemas de vídeo. Usar a mesma base de código NestJS facilita a manutenção e evolução da pipeline.
**Libraries:** fluent-ffmpeg

### phase-03-videos/TD-04

**Recommendation:** NanoID público + Pre-Signed URLs de Leitura (Option B) — Assim como no upload, transferir o esforço do streaming (bytes) para o storage é a abordagem mais performática. O backend atua apenas como emissor de tokens/URLs de acesso, removendo gargalos.
**Libraries:** nanoid

### phase-03-videos/TD-05

**Recommendation:** Máquina de estados Enum (DRAFT, UPLOADED, PROCESSING, READY, FAILED)
**Libraries:** —

## Inherited Decisions Detail

_No inherited TD details directly affecting this phase (auth tokens/passwords handled in Phase 02)._

## Inherited Conventions

- Backend config uses `@nestjs/config` com namespaced `registerAs` (Phase 01)
- Validation via `class-validator` + `class-transformer` (Phase 02)
- Formato de exceções customizado usando Domain Exception Filter (Phase 02)
- TypeOrmEntities vinculadas (O canal é criado automaticamente, Vídeos pertencerão a um Channel) (Phase 02)

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | Frontend framework não foi priorizado; API é a entrega primária. |

## UI Inventory

_No screen inventory — UI↔API sync deferred._

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|-----------|--------|-----------|---------|
| Telas de frontend para as funcionalidades de vídeo | deferred | Frontend UI fica para depois | — |

## Testing Requirements

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Controllers | e2e tests |
| Services | unit, integration |
| Workers/Processors | integration |
