FROM python:3.12-slim

WORKDIR /app

COPY pyproject.toml .
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir agno fastapi "uvicorn[standard]" httpx pydantic

COPY main.py .
COPY src/ ./src/

EXPOSE 8100

CMD ["python", "main.py"]
