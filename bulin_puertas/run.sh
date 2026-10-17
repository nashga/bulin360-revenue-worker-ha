#!/usr/bin/with-contenv sh
# Bulín Puertas · arranque con el entorno del contenedor (SUPERVISOR_TOKEN) bajo s6-overlay
exec python3 -I /app/server.py
