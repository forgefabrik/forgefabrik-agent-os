FROM node:20-slim

WORKDIR /app

RUN apt-get update && apt-get install -y python3 python3-pip curl bash && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY decision/api/requirements.txt /tmp/requirements.txt
RUN pip3 install --no-cache-dir -r /tmp/requirements.txt

COPY . .

# Verify event log on build (fail fast if chain is broken)
RUN node .task-locks/audit.mjs --no-snapshot --json

EXPOSE 7337

CMD ["bash", "decision/start.sh"]
