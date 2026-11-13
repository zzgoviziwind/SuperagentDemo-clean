FROM python:3.12-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
COPY requirements-lock.txt ./
RUN pip install --no-cache-dir -r requirements-lock.txt
COPY superagent ./superagent
RUN useradd --create-home --uid 10001 superagent && mkdir -p /state/workspaces && chown -R superagent:superagent /state
USER superagent
EXPOSE 8765
CMD ["python", "-m", "uvicorn", "superagent.main:app", "--host", "0.0.0.0", "--port", "8765", "--proxy-headers", "--forwarded-allow-ips", "*"]
