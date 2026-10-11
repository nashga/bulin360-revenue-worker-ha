# Changelog

## 0.3.2

- Lector de canales ch1.0.2 (igual que la extensión 0.5.2): en Airbnb, «No hay apartamentos disponibles para estas fechas» (anuncios con varias
  unidades) cuenta como sin disponibilidad en vez de «estructura cambiada»; si falta el bloque de reserva, decide el calendario de la propia página
  (noche ocupada, sin entrada/salida o estancia mínima).

## 0.3.1

- Lector de canales ch1.0.1 (mismo que la extensión 0.5.1): VRBO detecta las fichas que no están en VRBO (ids de hoteles de Expedia)
  y responde «estructura cambiada · listing_not_on_vrbo» en vez de darlas por cerradas. MisterPlan también por reservaonline.support y mrplan.io.

## 0.3.0

- **Canales (Panel Admin ≥ 0.29.0, M18):** además de Booking lee Airbnb (calendario de 12 meses por la API de la propia página y precio de la estancia),
  VRBO (calendario del selector de fechas y precio con tasas), Amenitiz (calendario y precio por su API pública) y Avirato (precio por estancia),
  y hace la «sonda» que detecta el motor de reservas de la web de un competidor. Lector compartido con la extensión 0.5.0: `channel-reader-core.js` (ch1.0.0).
- Solo recibe trabajos de canal porque los anuncia en `claim.capabilities`; con el Panel antiguo todo sigue igual (solo Booking).
- Un CAPTCHA en Airbnb o VRBO no pausa el worker: el Panel enfría ese canal 30 min y el worker sigue con Booking y el resto.
- Opciones nuevas: `channels` (activar canales) y `channels_direct` (webs de motores directos y sonda).

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
