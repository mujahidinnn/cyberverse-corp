# Image eksekusi kode agen (PRD §5.8). Dijalankan read-only, non-root, tanpa network untuk tool MEDIUM.
FROM python:3.12-slim
RUN pip install --no-cache-dir pytest==8.3.4 \
 && apt-get update && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
