FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY worker.py test_worker.py /app/
RUN useradd -m -u 10001 radar
USER radar
CMD ["python","-u","worker.py"]
