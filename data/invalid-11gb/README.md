# Arquivo de Teste: Vídeo Inválido de 11GB

- **Nome do arquivo:** `video_11gb.mp4`
- **Tamanho exato:** `11.811.160.064` bytes (exatamente 11 GB / $11 \times 1024^3$)
- **Finalidade:** Teste de bloqueio antecipado (*fail-fast*) de arquivo que excede o limite máximo permitido de 10GB (`10.737.418.240` bytes).
- **Como utilizar no Postman:**
  - Na Collection `docs/streamtube-postman-11gb-invalid.json`:
    - O request `3. Initiate Upload (11GB - Fail-Fast)` envia `"size": 11811160064`.
    - O backend rejeita imediatamente com **HTTP 413 Payload Too Large** (`VIDEO_SIZE_EXCEEDED`) em menos de 20ms, sem trafegar nenhum byte deste arquivo.
