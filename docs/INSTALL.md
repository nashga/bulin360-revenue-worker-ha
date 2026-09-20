# Instalación en Home Assistant

## 1. Visibilidad del repositorio

Durante el desarrollo el repositorio puede permanecer privado.

Para instalarlo directamente desde **Ajustes -> Complementos -> Tienda de complementos -> Repositorios**, Home Assistant debe poder descargar el repositorio. La opción más sencilla es publicar este repositorio una vez que esté listo.

No se guardan secretos en GitHub.

## 2. Añadir repositorio

Añadir:

`https://github.com/nashga/bulin360-revenue-worker-ha`

Después aparecerá **Bulin360 Revenue Worker**.

## 3. Configurar el worker

Cada Home Assistant necesita su propio token de worker.

Ejemplo:

```yaml
enabled: true
backend_base: "https://TU-DOMINIO-BULIN360"
worker_token: "TOKEN_UNICO_DEL_WORKER"
headless: true
lease_seconds: 120
claim_retry_seconds: 5
navigation_timeout_seconds: 60
reader_deadline_seconds: 18
locale: "es-ES"
timezone: "Europe/Madrid"
debug: false
```

## 4. Funcionamiento

El complemento:

1. Arranca Chromium.
2. Conserva el perfil del navegador en `/data/chromium`.
3. Reclama un trabajo de la cola central.
4. Abre la URL Booking recibida.
5. Confirma dos veces fechas/personas.
6. Espera 5 segundos adicionales para que Booking pinte la tabla comercial.
7. Ejecuta Reader v14.1.
8. Envía el resultado al mismo backend que el worker Chrome.
9. Reclama inmediatamente el siguiente trabajo.

Los estados CAPTCHA/BLOQUEADO son enviados al backend y pueden pausar el barrido.

## 5. Primera prueba

Para la primera instalación usar un worker PUBLIC y un barrido corto de un único competidor/fecha antes de incorporarlo al pool general.
