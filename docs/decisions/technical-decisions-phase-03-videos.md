---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-10-01
scope_description: "Decisões técnicas para a Fase 03: Upload e Processamento de Vídeos, abrangendo mensageria/fila, estratégia de upload de arquivos grandes, arquitetura do worker de processamento, streaming e ciclo de status."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — Módulo de vídeos na API principal, novo worker para processamento assíncrono (FFmpeg).
- `compose.yaml` — Adição da infraestrutura (Message Broker e Object Storage).

---

## TD-01: Tecnologia de Fila de Mensagens

**Scope:** Infraestrutura / Backend

**Capability:** Fila de processamento em segundo plano.

**Context:** O processamento de vídeos (extração de metadados e thumbnails) é intensivo e assíncrono. Precisamos de um message broker para enfileirar os trabalhos (jobs) e um worker para consumi-los, garantindo tolerância a falhas (retries).

**Options:**

### Option A: Redis + BullMQ
- Biblioteca baseada em Node.js suportada nativamente pelo NestJS (`@nestjs/bullmq`).
- **Pros:** Integração perfeita com NestJS. API robusta para agendamento, repetição, atraso e eventos de progresso. Infraestrutura simples (apenas um container Redis).
- **Cons:** Baseado em memória (Redis precisa ser configurado com persistência AOF/RDB para não perder jobs no restart).

### Option B: RabbitMQ (AMQP)
- Broker de mensageria de propósito geral, focado em roteamento complexo.
- **Pros:** Extremamente robusto, entrega garantida, suporte a múltiplos consumidores/filas complexas.
- **Cons:** Curva de aprendizado maior. O protocolo AMQP no NestJS (`@nestjs/microservices`) é mais complexo para casos simples de filas de tarefas (jobs com retries e delay) comparado ao BullMQ. Requer container mais pesado.

### Option C: Fila em Banco de Dados (PostgreSQL / pg-boss)
- Usar o banco relacional atual para gerenciar a fila de tarefas.
- **Pros:** Nenhuma infraestrutura adicional necessária (Postgres já existe). Transações atômicas com os dados do negócio.
- **Cons:** Polling constante ou LISTEN/NOTIFY sobrecarregam o banco sob alta concorrência. Não é tão otimizado para filas de alta vazão quanto brokers dedicados.

**Recommendation:** **Option A (Redis + BullMQ)** — É o padrão ouro no ecossistema NestJS para processamento de jobs (Job Queue). É mais fácil rastrear status, fazer *retries* e comunicar progresso. Redis é leve o suficiente para subir no Compose e atende perfeitamente ao caso de uso.

**Decision:** A (Redis + BullMQ)

---

## TD-02: Estratégia de Upload de Arquivos Grandes (10GB)

**Scope:** Backend / Storage

**Capability:** Upload de vídeos de até 10GB sem travar o sistema.

**Context:** Arquivos de 10GB passados diretamente pelo Node.js/NestJS iriam exaurir a memória (se não usar streams corretamente) e travariam o event loop. Além disso, consumiria muita banda da API e conexões de longa duração.

**Options:**

### Option A: Proxy via API com Streams
- O cliente faz o upload para a API NestJS, que repassa (stream) os bytes diretamente para o Object Storage (MinIO).
- **Pros:** Esconde as credenciais e arquitetura de storage do cliente. Autenticação e autorização feitas em tempo real.
- **Cons:** Mantém o servidor Node ocupado segurando a conexão durante todo o upload. Risco alto de timeout e queda de performance geral da API para conexões simultâneas longas.

### Option B: Pre-Signed URLs (Multipart Upload) diretamente para o Storage
- O cliente solicita à API autorização para upload. A API gera *Pre-Signed URLs* (válidas por tempo limitado) direto para o S3/MinIO. O cliente envia os pedaços (parts) diretamente para o Storage e, ao final, avisa a API para concluir.
- **Pros:** Remove totalmente a carga de rede e memória do Node.js. Escalabilidade máxima (Storage lida com os bytes pesados). Permite uploads paralelos e tolerância a quedas (resume de onde parou).
- **Cons:** Ligeiro aumento na complexidade do frontend/cliente.

**Recommendation:** **Option B (Pre-Signed URLs com Multipart Upload)** — Essencial para arquivos da ordem de gigabytes. É a única forma de atender ao requisito de "não travar a API durante o envio".

**Decision:** B (Pre-Signed URLs Multipart Upload)

---

## TD-03: Arquitetura do Worker de Vídeo

**Scope:** Backend

**Capability:** Extração de duração/metadados e geração de thumbnail via FFmpeg.

**Context:** O processamento multimídia é intensivo em CPU. Rodá-lo na mesma aplicação que serve o tráfego HTTP prejudicaria a latência das requisições.

**Options:**

### Option A: Processamento em Background no mesmo container da API
- O NestJS recebe o job na fila e executa o `child_process` (FFmpeg) na mesma máquina/container.
- **Pros:** Simples de implantar. Único código, único container.
- **Cons:** O FFmpeg competirá por CPU com a API HTTP. Não é escalável independentemente. Viola o princípio de isolar cargas intensivas.

### Option B: Container de Worker Isolado (Mesma base de código / Monorepo)
- O projeto usa o NestJS Standalone Application pattern para rodar o worker num container Docker separado, consumindo a mesma base de código (entities, config), mas com um *entrypoint* diferente (`main-worker.ts`).
- **Pros:** Isolamento total de CPU/Memória. Pode escalar horizontalmente só os workers. Reutilização do código (TypeORM, regras de negócio) sem duplicação.
- **Cons:** Consome mais memória (duas instâncias V8 rodando).

**Recommendation:** **Option B (Container de Worker Isolado)** — Rodar o FFmpeg num container apartado da API HTTP é uma prática obrigatória em sistemas de vídeo. Usar a mesma base de código NestJS facilita a manutenção e evolução da pipeline.

**Decision:** B (Container de Worker Isolado)

---

## TD-04: Streaming de Vídeo e URL Única

**Scope:** Backend

**Capability:** Streaming funcionando e URL única por vídeo sem conflito.

**Context:** Usuários devem conseguir acessar os vídeos através de uma URL amigável e segura, sem fazer o download integral (suporte a seeking/avanço).

**Options:**

### Geração do ID (URL única):
- **A) UUIDv4:** Padrão do banco (ex: `123e4567-e89b-12d3-a456-426614174000`). Único, mas longo para URLs.
- **B) NanoID / CUID2:** Strings mais curtas (ex: `V1StGXR8_Z5jdHi6B-myT`), colisão praticamente nula, *URL-safe*.
- **Decision:** B (NanoID) — Ideal para identificadores públicos de vídeos (estilo YouTube). O banco ainda usa UUID como Primary Key interna, mas o vídeo terá um `videoId` ou `slug` público via NanoID.

### Streaming:
- **A) Proxy via NestJS com Range Headers (206 Partial Content):** A API busca do MinIO em partes baseada no header `Range` requisitado pelo cliente e retorna com status HTTP 206.
- **B) Pre-Signed URL de Leitura Direta:** A API gera um link temporário para o MinIO, e o cliente consome o arquivo de lá (o MinIO já suporta Range Headers nativamente).
- **Recommendation:** **Option B (Pre-Signed URL para Leitura)** — Assim como no upload, transferir o esforço do streaming (bytes) para o storage é a abordagem mais performática. O backend atua apenas como emissor de *tokens/URLs* de acesso, removendo gargalos.

**Decision:** NanoID público + Pre-Signed URLs de Leitura (Option B)

---

## TD-05: Ciclo de Status do Vídeo

**Scope:** Domain Model

**Capability:** Rastrear o estado real de um vídeo desde o início do upload até estar pronto para reprodução.

**Context:** Quando usamos multipart upload direto pro storage, o arquivo é gerado no banco antes de existir de fato, exigindo controle do estado.

**Decision:**

O ciclo de vida será modelado pela enumeração `VideoStatus`:
1. **`DRAFT` (Pré-cadastro):** Registro criado no banco assim que o cliente solicita os links de upload. O vídeo não tem arquivo associado ainda.
2. **`UPLOADED` (Recebido):** O cliente finalizou o multipart upload e chamou o endpoint de completude na API. A API envia o Job para a fila e muda o status.
3. **`PROCESSING`:** O Worker pegou a mensagem da fila e começou a extrair thumbnail e metadados via FFmpeg.
4. **`READY`:** Processamento bem-sucedido. Thumbnail no storage, duração no banco. O vídeo já pode ser listado publicamente e ser consumido por streaming.
5. **`FAILED`:** Erro fatal no processamento ou limite de retries estourado no Worker.

Esta máquina de estados atende totalmente aos requisitos do "processamento automático e ciclo de status refletido no banco".
