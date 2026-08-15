# Seguimiento de OT — Taller de Servicio (Grupo Summit SMSA)

Aplicación web con backend propio y base de datos real (Postgres). No se
conecta al ERP: es independiente, se alimenta a mano.

Esta versión está pensada para desplegarse en servicios gratuitos en la
nube (Neon para la base de datos + Render para la aplicación), sin
depender de un servidor propio ni de autorización de IT. Todo el equipo
entra por un link público, protegido con usuario y clave.

**Importante — antes de partir:** los datos de clientes y vehículos van
a quedar alojados en servidores de terceros (Neon y Render), fuera de
la red de la empresa. Están protegidos con clave y la conexión va
cifrada, pero es una decisión consciente que ya se conversó: úsalo para
partir rápido, y si más adelante IT autoriza un servidor propio, se
puede migrar sin rehacer la app.

## Paso 1 — Crear la base de datos gratuita (Neon)

1. Entra a https://neon.tech y crea una cuenta gratuita (no pide tarjeta).
2. Crea un proyecto nuevo, cualquier nombre (ej: `seguimiento-ot`).
3. Neon te muestra una **cadena de conexión** (Connection string), algo así:
   ```
   postgresql://usuario:clave@ep-xxxx.neon.tech/neondb?sslmode=require
   ```
4. Cópiala y guárdala — la vas a necesitar en el paso 3.

## Paso 2 — Subir el código a GitHub

Render despliega leyendo un repositorio de GitHub.

1. Crea una cuenta gratuita en https://github.com si no tienes una.
2. Crea un repositorio nuevo (puede ser privado), ej: `seguimiento-ot`.
3. Sube el contenido de la carpeta `ot-app` (todos los archivos de este
   zip, menos `node_modules` si existiera) — se puede hacer arrastrando
   los archivos directamente en la web de GitHub, sin instalar nada,
   usando el botón "Add file" → "Upload files".

## Paso 3 — Desplegar en Render

1. Entra a https://render.com y crea una cuenta gratuita (puedes
   registrarte con la misma cuenta de GitHub).
2. "New +" → "Web Service" → conecta el repositorio que acabas de crear.
3. Configuración:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free
4. En la sección "Environment Variables", agrega:
   - `DATABASE_URL` → la cadena de conexión de Neon (paso 1)
   - `SESSION_SECRET` → cualquier frase larga y única, ej: `summit-taller-2026-xyz`
   - `NODE_ENV` → `production`
5. "Create Web Service". Render instala, construye y levanta la app
   (toma 2-3 minutos la primera vez).
6. Cuando termine, te da una URL pública como:
   ```
   https://seguimiento-ot.onrender.com
   ```
   Esa es la que comparte todo el equipo — cualquiera con el link entra
   desde su navegador (computador o celular), sin instalar nada.

## Primer ingreso

- **Usuario:** admin
- **Clave:** summit2026

Pide cambiar la clave apenas se ingresa por primera vez. Desde el botón
"Usuarios" (visible solo para el rol Administrador) se crean las cuentas
del resto del equipo.

## Una limitación del plan gratuito de Render

El plan free "duerme" la app si nadie la usa por 15 minutos, y tarda unos
20-30 segundos en "despertar" con la primera visita del día. Los datos
no se pierden (viven en Neon, no en Render), solo la primera carga del
día es un poco más lenta. Si eso llega a molestar en el uso diario, el
plan pagado de Render (desde USD 7/mes) elimina ese "sueño".

## Acceso por QR para técnicos (sin login, sin notebook)

Pensado para el piso del taller, donde los técnicos solo tienen celular:

1. Desde la app de escritorio, al editar una OT aparece el botón **"Ver QR"**.
2. Ese QR apunta a una página móvil (`/t/[id-de-la-OT]`) donde, sin
   necesidad de usuario ni clave, se puede: ver la etapa actual, avanzar
   o retroceder de etapa, y elegir el nombre de quien hace el cambio
   desde una lista (no requiere escribir ni tener clave).
3. Desde "Ver QR" también se puede **imprimir** el código para pegarlo
   en la orden de trabajo física o en el vehículo.

Importante: esa página móvil no pide clave a propósito, para que
cualquier técnico con el celular la pueda usar de inmediato. Quien
tenga el enlace de una OT puede actualizar esa OT puntual, pero no ve
el resto del tablero ni los datos de usuarios. Al estar en Render, el
link ya viaja por HTTPS.

## Estructura del proyecto

```
ot-app/
  server.js          backend (Express) — login, roles, API de OT
  package.json
  data/db.json        base de datos (se crea sola al iniciar)
  public/
    index.html         pantallas de login y tablero
    app.js              lógica del tablero, conectada a la API
    styles.css
```

## Flujo de etapas incluido

Recepción → Diagnóstico → Presupuesto/Aprobación → Repuestos → Reparación
→ Control de calidad → Lavado → Entrega

Sucursales precargadas: Summit Colón, Rancagua, Matta, Antofagasta, Calama.

Ambas listas se pueden editar directamente en `server.js` (constantes
`STAGES` y `SUCURSALES` al inicio del archivo) si cambia el proceso o
se agregan sucursales.
