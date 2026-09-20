# Protocolo Bulin360 Revenue Worker

Compatibilidad inicial:

- Panel Admin: v0.3.106
- Chrome worker de referencia: v0.3.103
- Reader: v14.1-worker+settle5s
- Home Assistant worker: ha-0.1.0

## Endpoints

### Claim

`POST /api/revenue/worker/claim.php`

Cabeceras:

- `X-Bulin-Worker-Token`
- `Authorization: Bearer <token>`

Datos principales enviados:

- lease_seconds
- ext_version
- reader_version

### Heartbeat

`POST /api/revenue/worker/heartbeat.php`

Renueva el lease del trabajo mientras se procesa.

### Result

`POST /api/revenue/worker/result.php`

Entrega:

- job_id
- attempt_id
- status
- reason
- final_url
- duration_ms
- reader_version
- ext_version
- payload
- envelope
- error_detail

## Estados compatibles

- OK
- PARCIAL
- SIN_DISPONIBILIDAD
- RESTRICCION
- PROPERTY_NOT_AVAILABLE_FOR_DATES
- CAPTCHA
- BLOQUEADO
- TIMEOUT
- ESTRUCTURA_CAMBIADA
- INCONSISTENTE
- ERROR

## Reglas conservadas de v0.3.103

- No se acepta una URL que no sea Booking HTTPS.
- El contexto check-in/check-out/personas debe coincidir.
- Se exigen dos comprobaciones consecutivas correctas.
- Tras confirmar contexto se esperan 5 segundos antes de leer la tabla.
- El contexto se revalida después de esa espera.
- Los validation_warnings no degradan por sí solos una lectura comercial válida a PARCIAL.
- Los errores de coherencia producen INCONSISTENTE.
- PROPERTY_NOT_AVAILABLE_FOR_DATES solo se usa como fallback cuando no existen datos comerciales útiles y Booking ha redirigido la propiedad.
