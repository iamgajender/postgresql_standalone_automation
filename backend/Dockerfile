FROM python:3.12-slim

WORKDIR /app

# Install system packages
RUN apt-get update && \
    apt-get install -y \
    ansible \
    sshpass \
    openssh-client && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

COPY backend /app/backend
COPY pg_an /app/pg_an

WORKDIR /app/backend

CMD ["gunicorn", "--workers", "3", "--bind", "0.0.0.0:5000", "app:app"]
