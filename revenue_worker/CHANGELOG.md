# Changelog

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
