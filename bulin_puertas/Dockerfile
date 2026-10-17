ARG BUILD_FROM
FROM $BUILD_FROM
RUN apk add --no-cache python3 tzdata
WORKDIR /app
COPY app/ /app/
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 TZ=Europe/Madrid
CMD ["python3", "-I", "/app/server.py"]
