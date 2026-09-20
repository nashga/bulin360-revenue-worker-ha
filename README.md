# Bulin360 Revenue Worker for Home Assistant

Repositorio oficial del add-on **Bulin360 Revenue Worker** para Home Assistant.

Este worker ejecuta trabajos de Revenue / Competencia de Bulin360 desde una instalación de Home Assistant, usando la misma cola central del Panel Admin y la misma lógica de lectura de Booking que el worker Chrome.

## Estado

Primera adaptación Home Assistant basada en:

- Panel Admin: `v0.3.106`
- Worker Chrome: `v0.3.103`
- Reader Booking: `v14.1-worker+settle5s`
- Protocolo backend: `claim -> heartbeat -> result`

## Seguridad

Este repositorio no contiene tokens, contraseñas ni claves privadas.

Cada instalación de Home Assistant configura su propio:

- `backend_base`
- `worker_token`

Los secretos quedan en la configuración local del add-on.

## Instalación

Añadir este repositorio a la tienda de add-ons de Home Assistant y después instalar **Bulin360 Revenue Worker**.

> La primera versión está orientada a workers PUBLIC. El perfil de Chromium se guarda de forma persistente en `/data` para permitir futuras variantes con sesión.
