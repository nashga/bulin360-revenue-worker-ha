# Bulín Puertas

Puertas de la casa (Nuki, Danalock por Z-Wave y portales Shelly) conectadas al Panel de El Bulín, sin Availroom.
Independiente de la app de Revenue: se instala y actualiza por separado.

## Qué hace

- Descubre sola las cerraduras de este Home Assistant (entidades `lock.*`) y los Shelly de portal (switch de la integración Shelly).
- Envía su estado al Panel (abierta/cerrada, batería, puerta abierta, atascada, sin conexión) cada 20 segundos.
- Recoge cada 3 segundos las órdenes de abrir o cerrar del Panel y del Control y las ejecuta aquí. Conexión solo de salida: no hay que abrir puertos.
- Panel «Puertas» en la barra lateral para abrir y cerrar en local (también queda registrado en el Panel).
- Nuki: «Abrir» retira también el resbalón. Shelly: solo pulsar (el Shelly se apaga solo).

## Configuración

1. En el Panel: Servicios → Aperturas → Home Assistant → «Añadir Home Assistant». Elige sus alojamientos y copia el token.
2. Aquí, en Configuración, pega el token en «Token de este Home Assistant» y guarda.
3. Inicia la app y activa «Mostrar en la barra lateral».
4. En el Panel, relaciona cada cerradura con su alojamiento y cada portal con los alojamientos que abre.

Opciones:
- **Otros portales**: solo si un portal no es un Shelly (un botón o un script).
- **Ocultar**: entidades que no deben aparecer ni enviarse al Panel.
- **Pedir confirmación**: preguntar antes de abrir o cerrar en el panel local.

Solo para personal autorizado de El Bulín: el panel local lo ven los usuarios de este Home Assistant.
