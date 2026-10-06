#!/usr/bin/env python3
"""
Upload Large Video Helper Script (StreamTube)
=============================================
Gerencia o fatiamento (slicing) inteligente e streaming ultrarrápido de arquivos grandes (ex: 8GB)
direto para o MinIO local via sockets HTTP em múltiplas partes (multipart upload), mantendo uso de RAM
mínimo (<8MB) e concluindo em menos de 30 segundos (~500 MB/s).

Modos de Uso:
  1) Hand-off com Postman (Recomendado):
     python scripts/upload_large_video.py --nano-id <NANO_ID> --file data/valid-8gb/video_8gb.mp4

  2) Fluxo 100% automatizado (Login -> Draft -> Initiate -> Upload Slices -> Complete):
     python scripts/upload_large_video.py --auto --file data/valid-8gb/video_8gb.mp4

  3) Upload direto de uma única parte via Pre-Signed URL:
     python scripts/upload_large_video.py --url "<URL_PREASSINADA>" --file data/valid-8gb/video_8gb.mp4
"""

import os
import sys
import time
import json
import math
import argparse
from datetime import datetime
from urllib.parse import urlsplit
import http.client
import urllib.request
import urllib.error

# Força UTF-8 seguro no console Windows (evita erros com caracteres de formatação)
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

CHUNK_SIZE = 8 * 1024 * 1024  # 8 MB chunks por leitura de socket
DEFAULT_PART_SIZE_MB = 512    # 512 MB por parte (8GB -> 16 partes de 512MB)
MIN_PART_SIZE_BYTES = 5 * 1024 * 1024  # 5 MB mínimo do S3


def log(level: str, message: str):
    now = datetime.now().strftime("%H:%M:%S")
    colors = {
        "INFO": "\033[36m",     # Cyan
        "START": "\033[34m",    # Blue
        "UPLOAD": "\033[33m",   # Yellow
        "SUCCESS": "\033[32m",  # Green
        "ERROR": "\033[31m",    # Red
        "ETAG": "\033[35m",     # Magenta
        "NEXT": "\033[96m",     # Light Cyan
    }
    reset = "\033[0m"
    color = colors.get(level, "")
    print(f"[{now}] {color}[{level:7s}]{reset} {message}")


def calculate_slicing(total_size: int, part_size_mb: int = DEFAULT_PART_SIZE_MB, forced_parts: int = None):
    """
    Calcula número de partes e intervalos de bytes para cada fatia respeitando regras do S3:
    - Mínimo 5MB por parte (exceto a última)
    - Máximo 5GB por parte
    - Máximo 10.000 partes
    """
    if forced_parts and forced_parts > 0:
        num_parts = forced_parts
        part_size = math.ceil(total_size / num_parts)
    else:
        part_size = part_size_mb * 1024 * 1024
        # Garante que não exceda 5GB
        part_size = min(part_size, 5 * 1024 * 1024 * 1024)
        # Garante que respeite o limite de 10.000 partes
        if total_size / part_size > 10000:
            part_size = math.ceil(total_size / 10000)
        num_parts = math.ceil(total_size / part_size)

    slices = []
    for i in range(num_parts):
        start = i * part_size
        end = min((i + 1) * part_size, total_size)
        length = end - start
        slices.append({
            "part_number": i + 1,
            "start": start,
            "end": end,
            "length": length,
        })

    return slices


def stream_upload_slice(
    url: str,
    filepath: str,
    start_offset: int,
    slice_length: int,
    part_number: int,
    total_parts: int,
    overall_progress: dict,
) -> str:
    """
    Transfere uma fatia do arquivo (start_offset .. start_offset + slice_length)
    para o MinIO via socket HTTP PUT na pre-signed URL, sem carregar na memória RAM.
    """
    parsed = urlsplit(url)
    original_host = parsed.netloc

    # Traduz minio:9000 para localhost:9000 se executado do host
    if "minio:9000" in url:
        connect_host = "localhost"
        connect_port = 9000
    else:
        connect_host = parsed.hostname or "localhost"
        connect_port = parsed.port or (443 if parsed.scheme == "https" else 80)

    path_with_query = parsed.path + ("?" + parsed.query if parsed.query else "")

    conn = http.client.HTTPConnection(connect_host, connect_port, timeout=600)
    try:
        conn.putrequest("PUT", path_with_query, skip_host=True)
        conn.putheader("Host", original_host)
        conn.putheader("Content-Length", str(slice_length))
        conn.endheaders()

        slice_transferred = 0
        last_update_time = time.time()
        bar_len = 22

        with open(filepath, "rb") as f:
            f.seek(start_offset)
            while slice_transferred < slice_length:
                to_read = min(CHUNK_SIZE, slice_length - slice_transferred)
                chunk = f.read(to_read)
                if not chunk:
                    break

                conn.send(chunk)
                slice_transferred += len(chunk)
                overall_progress["transferred"] += len(chunk)

                now = time.time()
                if now - last_update_time >= 0.12 or slice_transferred == slice_length:
                    tot_uploaded = overall_progress["transferred"]
                    tot_size = overall_progress["total_size"]
                    elapsed = max(now - overall_progress["start_time"], 0.001)
                    speed_bps = tot_uploaded / elapsed
                    speed_mb = speed_bps / (1024 * 1024)
                    rem_bytes = max(tot_size - tot_uploaded, 0)
                    eta_s = int(rem_bytes / speed_bps) if speed_bps > 0 else 0

                    overall_pct = (tot_uploaded / tot_size) * 100
                    filled = int(bar_len * tot_uploaded // tot_size)
                    bar = "=" * filled + "-" * (bar_len - filled)
                    trans_gb = tot_uploaded / (1024 ** 3)
                    tot_gb = tot_size / (1024 ** 3)

                    sys.stdout.write(
                        f"\r[{datetime.now().strftime('%H:%M:%S')}] [UPLOAD ] "
                        f"Part {part_number:02d}/{total_parts:02d} [{bar}] {overall_pct:5.1f}% "
                        f"({trans_gb:5.2f}GB/{tot_gb:5.2f}GB) | {speed_mb:6.1f} MB/s | ETA: {eta_s:2d}s"
                    )
                    sys.stdout.flush()
                    last_update_time = now

        resp = conn.getresponse()
        resp_data = resp.read()

        if resp.status not in (200, 201):
            sys.stdout.write("\n")
            log("ERROR", f"MinIO respondeu com HTTP {resp.status} na parte {part_number}: {resp_data.decode(errors='ignore')}")
            sys.exit(1)

        etag = resp.getheader("ETag", "").replace('"', "").strip()
        return etag

    finally:
        conn.close()


def authenticate(api_url: str, email: str, password: str) -> str:
    log("INFO", f"Autenticando usuário '{email}'...")
    login_req = urllib.request.Request(
        f"{api_url}/auth/login",
        data=json.dumps({"email": email, "password": password}).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(login_req) as res:
            login_data = json.loads(res.read().decode())
            log("SUCCESS", "Autenticação bem-sucedida! Token JWT obtido.")
            return login_data["access_token"]
    except Exception as e:
        log("ERROR", f"Falha no login: {e}")
        sys.exit(1)


def create_draft_video(api_url: str, auth_headers: dict, filename: str) -> str:
    log("INFO", "Criando vídeo em rascunho (Draft)...")
    draft_req = urllib.request.Request(
        f"{api_url}/videos",
        data=json.dumps({"title": f"Upload Test {filename}"}).encode(),
        headers=auth_headers,
    )
    with urllib.request.urlopen(draft_req) as res:
        draft_data = json.loads(res.read().decode())
        nano_id = draft_data["nano_id"]
        log("SUCCESS", f"Vídeo Draft criado com nano_id: {nano_id}")
        return nano_id


def initiate_upload(api_url: str, auth_headers: dict, nano_id: str, total_size: int, parts_count: int):
    log("INFO", f"Iniciando upload na API (Initiate Upload)...")
    log("INFO", f"  -> NanoId : {nano_id}")
    log("INFO", f"  -> Size   : {total_size:,} bytes ({(total_size / (1024**3)):.2f} GB)")
    log("INFO", f"  -> Partes : {parts_count}")

    initiate_req = urllib.request.Request(
        f"{api_url}/videos/{nano_id}/upload/initiate",
        data=json.dumps({
            "contentType": "video/mp4",
            "parts": parts_count,
            "size": total_size,
        }).encode(),
        headers=auth_headers,
    )
    try:
        t0 = time.time()
        with urllib.request.urlopen(initiate_req) as res:
            init_data = json.loads(res.read().decode())
            dt_ms = (time.time() - t0) * 1000
            log("SUCCESS", f"Upload iniciado com sucesso na API ({dt_ms:.1f}ms)!")
            log("SUCCESS", f"UploadId: {init_data['uploadId']} | {len(init_data['preSignedUrls'])} URLs pré-assinadas geradas")
            return init_data
    except urllib.error.HTTPError as e:
        err_body = e.read().decode()
        log("ERROR", f"API recusou upload com HTTP {e.code}: {err_body}")
        sys.exit(1)


def complete_upload(api_url: str, auth_headers: dict, nano_id: str, upload_id: str, completed_parts: list):
    log("INFO", f"Finalizando upload na API (Complete Upload com {len(completed_parts)} partes)...")
    complete_req = urllib.request.Request(
        f"{api_url}/videos/{nano_id}/upload/complete",
        data=json.dumps({
            "uploadId": upload_id,
            "parts": completed_parts,
        }).encode(),
        headers=auth_headers,
    )
    try:
        t0 = time.time()
        with urllib.request.urlopen(complete_req) as res:
            comp_data = json.loads(res.read().decode())
            dt_ms = (time.time() - t0) * 1000
            status = comp_data.get("status")
            log("SUCCESS", f"Upload finalizado na API em {dt_ms:.1f}ms com status: {status}!")
            log("SUCCESS", "Job de transcodificação enviado para o BullMQ / FFmpeg Worker.")
            log("NEXT", f"Acompanhe o processamento via: GET {api_url}/videos/{nano_id}")
            return comp_data
    except urllib.error.HTTPError as e:
        err_body = e.read().decode()
        log("ERROR", f"Falha ao completar upload na API (HTTP {e.code}): {err_body}")
        sys.exit(1)


def upload_sliced_file(
    api_url: str,
    token: str,
    nano_id: str,
    filepath: str,
    part_size_mb: int = DEFAULT_PART_SIZE_MB,
    forced_parts: int = None,
    skip_complete: bool = False,
):
    """
    Executa o fluxo completo de fatiamento e envio:
    1. Inspeciona o arquivo e calcula as fatias ideais
    2. Chama Initiate Upload informando size e quantidade de partes
    3. Executa o streaming de cada fatia com barra de progresso em tempo real
    4. Chama Complete Upload enviando a lista de ETags
    """
    if not os.path.exists(filepath):
        log("ERROR", f"Arquivo não encontrado: {filepath}")
        sys.exit(1)

    total_size = os.path.getsize(filepath)
    total_gb = total_size / (1024 ** 3)

    slices = calculate_slicing(total_size, part_size_mb=part_size_mb, forced_parts=forced_parts)
    num_parts = len(slices)

    log("INFO", f"Arquivo local : {filepath} ({total_gb:.2f} GB / {total_size:,} bytes)")
    log("INFO", f"Estratégia    : Dividido em {num_parts} partes de ~{slices[0]['length'] // (1024 * 1024)}MB")

    auth_headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

    # 1. Initiate Upload na API
    init_data = initiate_upload(api_url, auth_headers, nano_id, total_size, num_parts)
    upload_id = init_data["uploadId"]
    presigned_urls = {item["partNumber"]: item["url"] for item in init_data["preSignedUrls"]}

    # 2. Upload de cada fatia para o MinIO
    log("START", f"Iniciando streaming das {num_parts} partes direto para o storage MinIO...")
    overall_progress = {
        "total_size": total_size,
        "transferred": 0,
        "start_time": time.time(),
    }

    completed_parts = []
    for s in slices:
        part_num = s["part_number"]
        part_url = presigned_urls.get(part_num)
        if not part_url:
            log("ERROR", f"URL pré-assinada ausente para a parte {part_num}!")
            sys.exit(1)

        etag = stream_upload_slice(
            url=part_url,
            filepath=filepath,
            start_offset=s["start"],
            slice_length=s["length"],
            part_number=part_num,
            total_parts=num_parts,
            overall_progress=overall_progress,
        )
        completed_parts.append({"PartNumber": part_num, "ETag": etag})

    sys.stdout.write("\n")
    sys.stdout.flush()

    total_duration = time.time() - overall_progress["start_time"]
    avg_speed_mb = (total_size / total_duration) / (1024 * 1024)
    log("SUCCESS", f"Todas as {num_parts} partes foram enviadas com sucesso em {total_duration:.1f}s (Média global: {avg_speed_mb:.1f} MB/s)!")

    # 3. Complete Upload
    if not skip_complete:
        complete_upload(api_url, auth_headers, nano_id, upload_id, completed_parts)
    else:
        log("INFO", "Etapa de Complete Upload ignorada (--no-complete).")
        log("INFO", f"UploadId: {upload_id}")
        log("INFO", "Parts JSON para envio manual:")
        print(json.dumps({"uploadId": upload_id, "parts": completed_parts}, indent=2))

    return completed_parts


def main():
    parser = argparse.ArgumentParser(
        description="StreamTube - Upload de Grandes Vídeos com Alto Desempenho e Fatiamento Dinâmico",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Exemplos de Uso:
  1) Hand-off com Postman (passando o nano_id criado no Postman):
     python scripts/upload_large_video.py --nano-id <NANO_ID> --file data/valid-8gb/video_8gb.mp4

  2) Fluxo 100% automatizado (Login -> Draft -> Initiate -> Upload 16 fatias -> Complete):
     python scripts/upload_large_video.py --auto --file data/valid-8gb/video_8gb.mp4

  3) Dividir em mais partes (ex: fatias de 256MB -> 32 partes para 8GB):
     python scripts/upload_large_video.py --auto --file data/valid-8gb/video_8gb.mp4 --part-size-mb 256

  4) Upload de uma parte específica via URL pré-assinada única:
     python scripts/upload_large_video.py --url "<URL_PREASSINADA>" --file data/valid-8gb/video_8gb.mp4
        """,
    )
    parser.add_argument("--file", default="data/valid-8gb/video_8gb.mp4", help="Caminho do arquivo local (padrão: data/valid-8gb/video_8gb.mp4)")
    parser.add_argument("--nano-id", help="Nano ID de um vídeo Draft existente (inicia o upload e fatia automaticamente)")
    parser.add_argument("--auto", action="store_true", help="Executa o fluxo completo do zero (cria draft automaticamente)")
    parser.add_argument("--api", default="http://localhost:3000", help="URL base da API (padrão: http://localhost:3000)")
    parser.add_argument("--email", default="user@example.com", help="Email para login (padrão: user@example.com)")
    parser.add_argument("--password", default="password123", help="Senha para login (padrão: password123)")
    parser.add_argument("--token", help="Token JWT existente (evita chamada de login)")
    parser.add_argument("--part-size-mb", type=int, default=DEFAULT_PART_SIZE_MB, help=f"Tamanho de cada fatia em MB (padrão: {DEFAULT_PART_SIZE_MB}MB)")
    parser.add_argument("--parts", type=int, help="Força a quantidade exata de partes para divisão do arquivo")
    parser.add_argument("--no-complete", action="store_true", help="Faz o upload das partes mas não chama Complete Upload")
    parser.add_argument("--url", help="URL pré-assinada avulsa para envio direto de 1 parte")

    args = parser.parse_args()

    if args.url:
        # Envio avulso de 1 URL
        if not os.path.exists(args.file):
            log("ERROR", f"Arquivo não encontrado: {args.file}")
            sys.exit(1)
        total_size = os.path.getsize(args.file)
        overall = {"total_size": total_size, "transferred": 0, "start_time": time.time()}
        etag = stream_upload_slice(args.url, args.file, 0, total_size, 1, 1, overall)
        print("\n" + "=" * 60)
        log("NEXT", f'ETag recebido: "{etag}"')
        print("=" * 60)
        return

    # Determina o token
    token = args.token
    if not token and (args.auto or args.nano_id):
        token = authenticate(args.api, args.email, args.password)

    if args.auto:
        auth_headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        filename = os.path.basename(args.file)
        nano_id = create_draft_video(args.api, auth_headers, filename)
        upload_sliced_file(
            api_url=args.api,
            token=token,
            nano_id=nano_id,
            filepath=args.file,
            part_size_mb=args.part_size_mb,
            forced_parts=args.parts,
            skip_complete=args.no_complete,
        )
    elif args.nano_id:
        upload_sliced_file(
            api_url=args.api,
            token=token,
            nano_id=args.nano_id,
            filepath=args.file,
            part_size_mb=args.part_size_mb,
            forced_parts=args.parts,
            skip_complete=args.no_complete,
        )
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
