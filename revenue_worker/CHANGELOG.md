# Changelog

## 0.2.0

- Core del lector **compartido** con el Panel Admin y la extensión Chrome 0.4.1 (`booking-reader-core.js` 1.2.0, copia idéntica de `assets/shared` del Panel).
- Identidad tras la lectura (`Core.applyIdentity`): si Booking canonicaliza el slug de la MISMA ficha se acepta (aviso `property_slug_canonicalized`);
  si la página es de OTRO alojamiento con datos → `INCONSISTENTE` con `property_mismatch` (el Panel no lo ingiere y reintenta a los 5 s);
  redirigida sin datos comerciales → `PROPERTY_NOT_AVAILABLE_FOR_DATES` (igual que antes).
- El slug de la propiedad se toma de `job.booking_slug` (Panel nuevo) o de `/hotel/<país>/<slug>`; el contexto incluye el nombre del competidor.
- Más textos de «no disponible en nuestra web» reconocidos como `PROPERTY_NOT_AVAILABLE_FOR_DATES` (solo si no hay selectores de habitaciones).
- Compatible con el Panel antiguo y con el nuevo (R26: HA ≥ ha-0.1.2, lector v14.1-worker+settle5s).

## 0.1.1

- Home Assistant fuerza Booking a EUR para igualar el entorno del worker Chrome.
- Relectura comercial hasta 3 veces en trabajos de precio cuando la tabla aún no ha pintado importes.
- Un trabajo PRICE sin precio utilizable ya no puede terminar en OK; se marca PARCIAL.
- Diagnóstico de resumen de payload disponible en modo debug.

## 0.1.0

- Primera adaptación del worker Chrome v0.3.103 a Home Assistant.
- Cola central compatible con claim / heartbeat / result.
- Chromium persistente en /data/chromium.
- Worker PUBLIC headless.
- Reader Booking v14.1 conservado como base.
- Pausa local ante CAPTCHA/BLOQUEADO.
