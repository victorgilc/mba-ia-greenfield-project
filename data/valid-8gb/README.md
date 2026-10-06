# Arquivo de Teste: Vídeo Válido de 8GB

- **Nome do arquivo:** `video_8gb.mp4`
- **Tamanho exato:** `8.589.934.592` bytes (exatamente 8 GB / $8 \times 1024^3$)
- **Finalidade:** Teste de upload de arquivo de grande porte dentro do limite permitido de 10GB.
- **Como utilizar no Postman:**
  - Na Collection `docs/streamtube-postman-8gb-valid.json`:
    - O `Initiate Upload` envia `"size": 8589934592`.
    - No request de upload da parte, selecione este arquivo `data/valid-8gb/video_8gb.mp4` ou utilize o script `scripts/upload_large_video.py`.
