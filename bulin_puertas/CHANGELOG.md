# Cambios

## 1.0.3
- Espacios de servicio del Panel (Caldera, Almacén, Lavandería, Restaurante…): el panel «Puertas» agrupa esas puertas con su nombre.

## 1.0.2
- Corrige el 401 de Home Assistant: el token del Supervisor no llegaba a la app con s6-overlay.
- Si la plantilla de HA falla, descubre las cerraduras solo con los estados.
- El registro indica cuántas cerraduras y portales envía al Panel, y los errores al leerlas.

## 1.0.1
- Se identifica ante el servidor como navegador compatible (el cortafuegos del hosting rechazaba la app con un 403).
- El registro muestra el motivo del rechazo del Panel.

## 1.0.0
- Primera versión: cerraduras (Nuki, Danalock) y portales Shelly, conexión de salida con el Panel (estado cada 20 s, órdenes cada 3 s), panel local «Puertas» y registro de aperturas.
