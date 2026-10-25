# Sync Servidor: sincroniza tus aparatos de Kino con tu propio servidor

[Read in English](README.md)

Este repositorio es **Sync Servidor** (id del plugin `sync-server`), un ejemplo completo y funcionando de un **proveedor de sincronización de Kino**: un
servidor pequeño que corres tú (`server.mjs`) y el plugin de Kino que habla con él (`plugin/`). Con
él, tu celular y tu TV mantienen el mismo historial, biblioteca y ajustes a través de **tu**
computador, en lugar de la red local o el servicio de otra persona.

Es un ejemplo para aprender y para copiar. No es parte de Kino y nadie lo corre por ti: el servidor
es tuyo, lo enciendes tú y es para tus propios aparatos. No es un plugin recomendado y Kino no lo
muestra en su lista: solo se instala escribiendo su dirección (paso 3). Necesita Kino 0.9.74 o más nuevo.

El botón **Ver la guía** del plugin abre este repositorio.

```
tu celular ─┐                                             ┌─ data/blob.bin   (la copia cifrada)
            ├─ https ─▶ túnel de Cloudflare ─▶ server.mjs ┼─ data/meta.json  (su versión)
tu TV  ─────┘                                             └─ data/token      (tu token de acceso)
```

## Qué necesitas

- Un computador que quede encendido mientras quieras sincronizar (Mac, Linux o Windows).
- **Node.js 18 o más nuevo**: `node --version` debe mostrar `v18` o más. Lo descargas de
  <https://nodejs.org>. No hay nada más que instalar: `server.mjs` no tiene dependencias.
- **cloudflared**, el programa de túneles de Cloudflare (gratis; un túnel rápido no necesita cuenta):
  - macOS: `brew install cloudflared`
  - Windows: `winget install --id Cloudflare.cloudflared`
  - Linux: mira <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/>
- Kino 0.9.74 o más nuevo en tus aparatos.

**¿Por qué un túnel?** Un plugin de Kino solo puede llegar a direcciones **https públicas**, en el
puerto 443. Nunca llega a tu red local, y nunca por http. El túnel le da al servidor de tu computador
una dirección https pública.

## 1. Enciende el servidor

Clona o descarga este repositorio donde quieras. Necesitas `server.mjs` y, al lado, la carpeta `plugin/`. Abre una
terminal en esa carpeta y ejecuta:

```sh
node server.mjs
```

La primera vez muestra algo así:

```
Kino sync demo listening on http://127.0.0.1:8787  (data in /…/sync-server/data)

Your new access token (shown only this once; it is also saved in /…/data/token):

  q3J0dX…(43 caracteres)…Xk

Paste it into the plugin's Token field. Anyone who has it can read your synced data.

Next: cloudflared tunnel --url http://127.0.0.1:8787
```

- **El token** es una cadena larga y al azar que se crea en el primer arranque y se guarda en
  `data/token`.
  - Los arranques siguientes lo reutilizan y no lo vuelven a mostrar. Abre `data/token` para verlo.
  - Para elegir el tuyo, arranca con `DEMO_TOKEN=<al menos 32 caracteres al azar> node server.mjs`.
    En PowerShell de Windows: `$env:DEMO_TOKEN="…"; node server.mjs`.
  - Nunca uses una contraseña inventada por ti. Kino saca la llave de cifrado de este token, así que
    debe ser largo y al azar.
- **Tus datos** quedan en `data/`, al lado de `server.mjs`. Con `DATA_DIR=/otra/carpeta` quedan en
  otra parte. Ahí están `blob.bin` (la copia cifrada), `meta.json` (su versión) y `token`.
- El servidor escucha solo en `127.0.0.1`, tu propio computador. `PORT=9000` cambia el puerto.
- Corre un solo servidor por carpeta de datos: dos tendrían cada uno su propia idea de la versión actual.
- Deja esta terminal abierta. `Ctrl+C` apaga el servidor.

Comprueba que funciona. En otra terminal, `curl http://127.0.0.1:8787/healthz` muestra `ok`.

## 2. Crea el túnel

### Opción A: túnel rápido (lo más rápido; la dirección cambia cada vez)

En una segunda terminal:

```sh
cloudflared tunnel --url http://127.0.0.1:8787
```

A los pocos segundos muestra un recuadro con una dirección como
`https://palabras-al-azar.trycloudflare.com`. Esa es la dirección pública de tu servidor **mientras
este comando siga corriendo**. Deja la terminal abierta.

- Un túnel rápido recibe una **dirección nueva al azar cada vez que lo enciendes**. Cuando la
  dirección cambia, tienes que escribir la nueva en el plugin de cada aparato (mira
  [Si algo falla](#si-algo-falla)).
- Cloudflare ofrece los túneles rápidos para pruebas, sin garantía de que estén siempre arriba.
- Sirve para probar. Para el día a día, usa la opción B.

Si ya usas cloudflared para otra cosa y tienes un `~/.cloudflared/config.yml`, el túnel rápido lee
las reglas de ese archivo y responde **404** a todo. Enciéndelo con un archivo de configuración vacío:

```sh
touch vacio.yml                     # Windows: type nul > vacio.yml
cloudflared tunnel --config vacio.yml --url http://127.0.0.1:8787
```

### Opción B: túnel con nombre (dirección fija; necesita una cuenta gratis de Cloudflare con un dominio)

```sh
cloudflared tunnel login                                    # abre el navegador una vez
cloudflared tunnel create kino-sync                         # crea el túnel y su archivo de credenciales
cloudflared tunnel route dns kino-sync sync.ejemplo.com     # un nombre de tu dominio
cloudflared tunnel run --url http://127.0.0.1:8787 kino-sync
```

Tu dirección queda siempre en `https://sync.ejemplo.com`. Para que el túnel arranque junto con tu
computador, mira la guía de Cloudflare "Run as a service".

**Comprueba el túnel:** abre `https://<tu dirección>/healthz` en un navegador. Dice `ok`. Un nombre
de túnel rápido recién creado puede tardar un minuto en aparecer para tu propio computador ("could
not resolve host"); el celular normalmente lo encuentra de una vez.

## 3. Instala el plugin en Kino

El servidor también entrega los archivos del plugin, así que lo instalas desde tu propia dirección.

1. En el celular, abre **Menú ▸ Plugins** y toca **+** (Agregar plugin). En la TV, abre **Plugins** y
   elige **Agregar plugin**.
2. Deja el tipo en **Kino**. En **Dirección del plugin**, escribe
   `https://<tu dirección>/plugin/kino-plugin.json` y toca **Agregar**. (O escribe
   `kinotvapp/kino-plugin-sync-server/plugin` para instalar el mismo plugin desde este repositorio, firmado
   por su autor: entonces la hoja muestra "Firmado".)
3. Kino muestra **Instalar Sync Servidor**. Dice *Es un plugin de la comunidad: instálalo si
   confías en quien lo creó.* No lleva la marca "Firmado": el plugin viene de una dirección, no de un
   repositorio de GitHub firmado.
4. Toca **Ver detalles** y lee las líneas en rojo:
   - *Sincronizará tus datos a través de su servicio: el plugin y su servicio podrán leerlos.* Es
     cierto; mira [Qué puede ver el servidor y qué no](#qué-puede-ver-el-servidor-y-qué-no).
   - *Puede conectarse a cualquier servidor público de internet (solo https, nunca tu red local).*
5. Toca **Instalar**. No hagas caso al mensaje de "ver su contenido en el Home": este plugin no
   muestra nada en el Home, solo sincroniza.

La dirección del plugin guarda el nombre del túnel. Con un túnel rápido, instala el plugin en cada
aparato mientras ese mismo túnel esté encendido. Kino también copia el plugin a tus otros aparatos
emparejados por esa dirección, y cada uno lo descarga por su cuenta.

## 4. Enciende el proveedor

1. Abre **Ajustes ▸ Ajustes de todos los perfiles ▸ Sincronización ▸ Proveedor**. *Sync Servidor*
   aparece debajo de **Red local**.
2. Enciende el interruptor de **Sync Servidor**.
3. Kino pregunta **"¿Sincronizar con Sync Servidor?"**:
   - La sincronización por red local se apaga mientras uses este proveedor.
   - Si el proveedor ya guarda datos de otro aparato, se combinan con los de este: no se pierde
     lo que solo tiene uno de los dos.
   - En rojo: el plugin y su servicio podrán leer los datos.

   Toca **Combinar con este aparato**.
4. La fila ahora dice *Falta el token: configúralo en Conectar*, con un botón **Conectar**.

## 5. Conectar: la dirección del servidor y el token

1. Toca **Conectar**. Se abre el formulario del plugin. Arriba, **Ayuda** dice en pocas líneas lo que
   necesitas (la dirección https del servidor y su token) y **Ver la guía** abre el repositorio de esta guía.
   - **Dirección del servidor**: `https://<tu dirección>`. Escribe solo eso: sin `/plugin`, sin
     puerto, sin `http://`, sin `192.168.…`.
   - **Token**: pega el token del paso 1.
2. Toca **Guardar**. La línea **Estado** dice *Conectado. El servidor aún no guarda nada.* **Probar
   conexión** le vuelve a preguntar al servidor cuando quieras.
3. Vuelve atrás. La primera sincronización corre de inmediato:
   - La fila dice *Sincronizado hace un momento*. Si todavía dice *Esperando la primera
     sincronización*, sal de la pantalla y vuelve a entrar.
   - En la terminal del servidor aparecen `GET /blob 204` y luego `PUT /blob 200`.

Desde ahí, Kino trae la copia cuando vuelve al frente y cada 5 minutos, y envía la suya más o menos
un minuto después de que algo cambie. **Sincronizar ahora** sincroniza en el momento.

## 6. Agrega tu segundo aparato

El segundo aparato solo necesita los mismos dos ajustes. Kino saca la misma llave del mismo token,
así que ninguna llave viaja entre tus aparatos.

Con los dos aparatos en el mismo Wi-Fi:

1. Instala el plugin también en el segundo aparato (paso 3), si todavía no está.
2. En el **segundo** aparato (por ejemplo la TV), abre **Ajustes de todos los perfiles ▸
   Sincronización ▸ Proveedor** y toca **Recibir desde otro aparato** debajo de *Sync Servidor*.
   El proveedor no tiene que estar encendido. Durante 3 minutos muestra:
   - un código QR;
   - una dirección como `192.168.1.`**`23`**`:38917`;
   - un código de 6 cifras.
3. En el **primer** aparato (el celular que ya sincroniza), abre la misma pantalla y toca **Enviar a
   otro aparato**.
   - Apunta la cámara al QR.
   - ¿Sin cámara, o no le diste permiso? Kino pasa a **Escribir dirección**. Escribe el último número
     de la dirección y el código de 6 cifras que muestra el otro aparato, y toca **Enviar**.
   - El celular dice *Enviado. Confírmalo en el otro aparato.*
4. El segundo aparato pregunta **"Recibido para Sync Servidor: ¿aplicar?"**. Muestra *Dirección
   del servidor* y *Token*, nunca sus valores. Toca **Aplicar**.
5. Luego pregunta "¿Sincronizar con Sync Servidor?" como en el paso 4. Toca **Combinar con este
   aparato**.

¿Están en redes distintas? En la pantalla de envío del celular elige **Otra red** y escribe las
palabras y el código que muestra la TV. En una TV, la página del plugin muestra solo su estado,
**Probar conexión** y el botón **Sincronización ▸ Proveedor** de Kino: la dirección y el token se
dibujan solo en el celular (`"devices": ["phone"]`), así que la TV los recibe con **Recibir desde otro
aparato**.

## 7. Comprueba que funciona

1. En el celular, agrega un título a tu biblioteca o mira un minuto de algo.
2. Toca **Sincronizar ahora** en la pantalla Proveedor, o espera un minuto.
3. En la TV, abre Kino o toca **Sincronizar ahora** allí. El título también está en su biblioteca.
4. La terminal del servidor muestra las líneas `GET /blob` y `PUT /blob` de los dos aparatos.

## Si algo falla

| Lo que ves | Qué significa y qué hacer |
| --- | --- |
| *Falta el token: configúralo en Conectar* | Este aparato no tiene el token. Toca **Conectar** y pégalo. |
| *El token no coincide o los datos guardados no son de Kino*, con **Corregir el token** y **Restablecer sincronización** | La copia del servidor se guardó con otro token. Pasa si cambiaste `DEMO_TOKEN`, borraste `data/token` o un aparato todavía tiene un token viejo. También pasa si algo distinto de Kino escribió en el servidor. **Si algún aparato todavía tiene el token correcto:** cópialo a este (**Corregir el token**). **Si el token viejo se perdió para siempre:** en un aparato toca **Restablecer sincronización** y confirma. La copia del servidor se reemplaza por la de este aparato, hecha con el token que tienes ahora. Luego pásales ese mismo token a tus otros aparatos (paso 6). |
| Estado: *El servidor no acepta el token. Copia otra vez el de data/token.* | El token del plugin no es el que usa el servidor. Copia otra vez `data/token`, los 43 caracteres. |
| *Falló la última sincronización: otro aparato guardaba al mismo tiempo, se volverá a intentar* | El servidor respondió `409`: otro aparato escribió primero. Kino trae la copia, combina y vuelve a enviar por su cuenta. Si lo ves todo el tiempo, dos aparatos con tokens distintos se están peleando: revisa los tokens. |
| Estado: *El túnel no responde: puede que su dirección haya cambiado o que server.mjs esté apagado.* | Con un túnel rápido, cada vez que reinicias `cloudflared` cambia la dirección. Escribe la nueva `https://….trycloudflare.com` en **Dirección del servidor** en cada aparato, o pásate a un túnel con nombre. Revisa también que las dos terminales sigan corriendo. |
| Estado: *No se pudo llegar al servidor. ¿Está encendido server.mjs y abierto el túnel?* | El computador está dormido o sin internet, o se detuvo `server.mjs` o `cloudflared`. Enciéndelos de nuevo. Tus datos se conservan. |
| Bajo el campo: *La dirección del servidor debe empezar con https://…* o *Esa dirección es de tu red local…* | Los plugins de Kino solo hablan https, en el puerto 443, con direcciones públicas. Usa la dirección del túnel, nunca `http://`, `localhost` ni `192.168.…`. |
| El túnel responde 404 a todo | Tienes un `~/.cloudflared/config.yml`. Enciende el túnel rápido con `--config vacio.yml` (paso 2). |
| Líneas `429` en la terminal del servidor, o *…está limitando las peticiones* | Demasiadas peticiones desde una dirección: más de 120 por minuto, o más de 10 tokens equivocados por minuto. Espera un minuto. Kino también limita cuántas peticiones hace un plugin a una dirección que no declaró. El límite distingue tus aparatos por el encabezado `CF-Connecting-IP` de Cloudflare solo cuando `cloudflared` corre en el mismo computador que el servidor; si no, todos comparten un mismo cupo (sigue habiendo límite, nunca queda sin límite). |
| *Falló la última sincronización: tus datos superan el tamaño que admite el proveedor* | Este ejemplo declara copias de hasta 4 MiB (4.194.304 bytes), lo máximo que Kino deja mover a un proveedor de sincronización. El servidor en sí acepta hasta 8 MiB. |
| Al instalar dice que Kino solo instala plugins desde direcciones https | Escribe la dirección `https://` del túnel, con `/plugin/kino-plugin.json` al final. |

## Qué puede ver el servidor y qué no

- **Los datos van cifrados.** Kino cifra la copia (AES-256-GCM) antes de dársela al plugin.
  `data/blob.bin` es texto cifrado; el servidor solo lo guarda y lo devuelve byte por byte.
- **Pero la llave sale del token.** Eso es lo que deja que un segundo aparato se una solo con la
  dirección del servidor y el token. Así que **cualquiera que tenga el token puede descifrar los
  datos**:
  - tú;
  - el plugin, que lee el token para enviarlo;
  - quien pueda leer `data/token` en tu computador;
  - quien copie el token de alguno de tus aparatos.
- **Cloudflare** lleva el tráfico por su túnel con https. Ve la copia cifrada, y también el token en
  el encabezado de la petición.
- **Qué hay en la copia:** todo lo que Kino sincroniza entre tus aparatos. Es decir, tu biblioteca,
  historial, avance y ajustes, y además tus plugins y sus ajustes. Las contraseñas van incluidas,
  selladas otra vez dentro de la copia.
- **Guarda `data/token` en privado.** Trátalo como la contraseña de todo lo anterior.
- **Para cambiar el token:**
  1. Apaga el servidor.
  2. Borra `data/token` (o pon un `DEMO_TOKEN` nuevo).
  3. Enciende el servidor.
  4. Pon el token nuevo en un aparato y toca allí **Restablecer sincronización**.
  5. Vuelve a enviar los ajustes a tus otros aparatos (paso 6).

## Copia de seguridad, apagar y limpiar

- **Copia de seguridad:** copia la carpeta `data/` con el servidor apagado.
- **Apagar:** presiona `Ctrl+C` en la terminal de `cloudflared` y en la de `server.mjs`. Tus aparatos
  conservan sus datos; solo no pueden sincronizar hasta que enciendas los dos otra vez.
- **Dejar de usarlo:** en Kino, en cada aparato, vuelve a encender **Red local** (o apaga el
  proveedor). Luego desinstala el plugin en **Plugins ▸ Instalados ▸ Gestionar ▸ Desinstalar**.
- **Borrar todo:** apaga los dos programas y borra la carpeta. Su carpeta `data/` es la única copia
  del servidor. Un túnel con nombre se borra con `cloudflared tunnel delete kino-sync`.

## Para quien escribe plugins

- **`server.mjs`:**
  - `GET /blob` responde 200 con un encabezado `X-Version`, o 204 si está vacío.
  - `PUT /blob` recibe `If-Match: <versión>` (`0` si está vacío). Responde 200 con el nuevo
    `X-Version`, o 409 con el actual, de forma atómica.
  - Exige `Authorization: Bearer <token>`, comparado en tiempo constante.
  - Un cuerpo de más de 8 MiB recibe 413. Hay un límite de peticiones por dirección.
  - Las escrituras son atómicas: un archivo temporal y luego un cambio de nombre.
  - `GET /healthz`, y los archivos del plugin en `/plugin/`.
  - Nunca escribe en el registro un token ni un cuerpo.
- **`plugin/`:**
  - `syncPull`, `syncPush` (un 409 se convierte en `throw kino.error("conflict")`) y `syncStatus`.
  - Un formulario de ajustes con una línea de estado y un botón de prueba, más `validateSettings`, y las
    ayudas de configuración de apiVersion 12: una `help` corta (lo que se necesita, no cómo montar el
    servidor) y un `link` a la guía.
  - El manifest declara `"capabilities": ["syncProvider"]` sola (un proveedor de sincronización no
    reproduce nada) y `"fetchHosts": "any"`. También declara
    `"sync": { "keySecret": "token", "provision": ["serverUrl", "token"], "maxBlobBytes": 4194304 }`.
  - `hosts` lleva el marcador `example.invalid`, porque un plugin sin un ajuste de tipo `url` debe
    declarar al menos un host.
- **`maxBlobBytes` es 4 MiB:** solo dentro de `syncPull` y `syncPush`, Kino deja que `kino.fetch` lleve
  ceil(`maxBlobBytes` × 4/3) + 64 KB (el blob en base64 y el resto de la petición); cualquier otra llamada
  sigue con el tope de 1 MB por petición. Declara lo que tu servidor de verdad acepta: también limita esas llamadas.
- **Pruebas:** `node --test test/*.test.mjs` corre las pruebas del servidor y el plugin dentro del kit
  de Node de Kino (la carpeta `sdk/` de este repositorio).
- **El contrato:** la guía de plugins de Kino (<https://kinotvapp.github.io/kino-plugins/sync-providers/>),
  `contract.json` y `kino.d.ts` en este repositorio.
