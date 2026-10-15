# Changelog

## 0.4.10
- Lector ch1.2.2: los importes de 4 cifras sin separador de miles («1151,50 EUR», «1210.00€») se leían truncados (115, 121). Corregido.

## 0.4.9
- Lector ch1.2.1: Avaibook con varias estancias (hoteles) da el precio más bajo que admite al grupo. En Airbnb, un grupo mayor que la capacidad del anuncio («Máximo 3 viajeros») queda como restricción y no como «estructura cambiada»; se envía la capacidad para que el Panel (≥ 0.42.3) no vuelva a pedir grupos que no caben.

## 0.4.8
- Corrige «Cannot read properties of undefined (reading 'run')» en Airbnb y otras webs: el lector de canales se carga por el propio navegador en cada página (también tras redirecciones y con CSP estricta) y se comprueba justo antes de leer.

## 0.4.7
- Lector ch1.2.0: tres motores directos nuevos.
  - SiteMinder (direct-book.com / thebookingbutton): precio por estancia leyendo las habitaciones y tarifas de la página con fechas y adultos.
  - RoomCloud (booking.roomcloud.net): precio por estancia a partir del «desde X €/Noche» de cada habitación (× noches).
  - Pinpoint Booking System (WordPress): calendario completo y precio por estancia desde el propio calendario de la web.
- Requiere el Panel 0.42.2 para recibir estos trabajos.

## 0.4.6
- VRBO: si el botón de fechas no aparece (pasaba ya sin captcha: título del anuncio bien pero sin selector), se recorre la página para que VRBO monte sus módulos, se busca el botón por varios caminos durante ~30 s y, si sigue sin salir, se reabre el anuncio sin fechas en la URL y se repite.
- El diagnóstico incluye qué botones y módulos había en la página cuando no se abre.

## 0.4.5
- VRBO se abre en una sesión limpia (incógnito) en cada lectura: sin las cookies que VRBO marca como robot y que hacían salir «¿Eres un robot?» una y otra vez.

## 0.4.4
- VRBO: apertura del calendario más robusta en equipos lentos (espera a que cargue la página, hasta 5 intentos con ratón o teclado).
- Diagnóstico en el registro (`[vrbo] calendario …`) y en el Panel (motivo de las lecturas parciales).

## 0.4.3

- Anuncia `trusted_click`: el Panel (≥ 0.40.1) le reserva los calendarios de VRBO, que solo se abren con un clic real (la extensión de Chrome no puede).

## 0.4.2

- Lector ch1.1.2 (igual que la extensión 0.6.2): si ninguna habitación admite el grupo o el motor no tiene tarifas, la lectura queda parcial
  (no «sin disponibilidad»); MisterPlan distingue «el establecimiento está completo» de un error del propio motor.

## 0.4.1

- VRBO solo abre su calendario con un clic real (un clic por script ya no lo abre): el worker lo hace con Playwright, rechazando antes las cookies, y el
  lector ch1.1.1 lee los días. Si aun así no se abre, la lectura queda parcial (no «estructura cambiada»).

## 0.4.0

- Lector de canales ch1.1.0 (igual que la extensión 0.6.0): motores directos nuevos. Availroom v3 (API pública con entorno y propiedad),
  MisterPlan (búsqueda de mrplan.io con casa y punto de venta), Avaibook (página de reserva con fechas y capacidad) y Thelis (campings) leen el
  precio por estancia; HBook (WordPress) lee el calendario de la página. La sonda ya no confunde el enlace a la web comercial de un motor con su widget.

## 0.3.4

- Lector de canales ch1.0.4 (igual que la extensión 0.5.4): rechaza el aviso de cookies de VRBO (OneTrust) antes de leer; calendario de VRBO en fichas
  tipo alojamiento sin colores de ocupación (solo los días «no disponible» cuentan como cerrados; sin ninguno, lectura parcial en vez de error);
  en «estructura cambiada» envía una pista de lo que vio (título, fechas del selector, bloques presentes).

## 0.3.3

- Lector de canales ch1.0.3 (igual que la extensión 0.5.3): en VRBO, «Este alojamiento no está disponible en Vrbo para tus fechas» cuenta como
  sin disponibilidad en vez de «estructura cambiada».

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
