# Configurar Make para enviar invitaciones por correo

WhatsApp se envía manualmente desde el panel. Make solo necesita este escenario:

**Custom webhook → Send an email → Webhook response**

## 1. Crear el escenario

En Make, abre **Scenarios → Create a new scenario**. Nómbralo **RV Reformas fiscales 2027 - Enviar correo**.

## 2. Crear el webhook

Agrega **Webhooks → Custom webhook → Add** y usa el nombre `rv_enviar_correo`.
Activa **API Key authentication**, crea una clave y guárdala de forma segura junto con la URL generada. La integración enviará la clave en el encabezado `x-make-apikey`.

## 3. Definir los campos

En **Advanced settings → Data structure**, define los siguientes campos de texto:

| Campo | Contenido |
|---|---|
| `invitation_id` | ID de la invitación |
| `guest_name` | Nombre del invitado (“invitado” si falta); se usa como nombre del destinatario |
| `greeting` | Saludo listo para el correo: “Estimado(a) Ana:” o, sin nombre, “Reciba un cordial saludo.” |
| `email` | Correo del destinatario |
| `invitation_url` | URL publicada con el token personal |

También puedes usar **Run once** y una petición de prueba para detectarlos. Este ejemplo describe el contrato propuesto; los identificadores y la URL deben sustituirse por valores reales en la prueba integrada:

```json
{
  "invitation_id": "ID_REAL",
  "guest_name": "Ana",
  "greeting": "Estimado(a) Ana:",
  "email": "TU_CORREO_DE_PRUEBA",
  "invitation_url": "https://TU-DOMINIO/registro/TOKEN_REAL"
}
```

## 4. Conectar el correo

Si la cuenta remitente usa Gmail o Google Workspace, agrega **Gmail → Send an email → Create a connection** e inicia sesión con esa cuenta. Si utiliza otro proveedor, usa su módulo de correo equivalente.

| Campo | Configuración |
|---|---|
| To | Seleccionar `email` del webhook |
| Subject | `RV Invitación Reformas Fiscales 2027` |
| Body type | `Collection of contents` |
| Body contents | Texto de abajo, insertando nombre y enlace desde el selector de Make |

> Estimados clientes y amigos:
>
> Tenemos el agrado de invitarlos a nuestra conferencia de **Reformas Fiscales 2027**.
>
> **Fecha:** jueves 3 de diciembre de 2026
> **Horario:** de 16:00 a 19:30 hrs. (registro a partir de las 15:30 hrs.)
> **Lugar:** Hotel RIU Guadalajara
>
> Para confirmar su asistencia, les solicitamos dar clic en el recuadro **“Regístrese aquí”** que aparece en la invitación de este correo y completar su registro con la misma dirección de correo electrónico en la que lo recibieron, ya que la invitación es personal e intransferible.
>
> Una vez completado su registro, recibirán en esa misma dirección el código QR que les permitirá acceder a la conferencia.
>
> Será un placer contar con su asistencia y saludarlos personalmente durante el evento.
>
> Quedamos a sus órdenes para cualquier duda o aclaración.
>
> Atentamente,
>
> Ruvalcaba Villalobos y Compañía, S.C.

Para un correo con diseño, usa como contenido HTML `emails/invitacion-make.html`; las imágenes de la invitación se sirven desde `https://rv-evento.vercel.app/brand/`, así que deben estar publicadas en Vercel antes de enviar. El correo mide como máximo 640 px (también en Outlook de escritorio, con una tabla condicional `[if mso]`), para que el texto no se extienda de más en pantallas grandes. El correo ya no lleva encabezado con logo y 40 aniversario (desde el 2026-11-17): empieza directo con el saludo. Cada párrafo lleva margen explícito y `hyphens:none` / `mso-hyphenate:none` para que ningún cliente de correo corte palabras con guion («direc-ción»), y «Atentamente,» y la firma van separados 36 px del texto. El horario se escribe «de 16:00 a 19:30 hrs.» en todos lados (sitio, invitación, entrada y correos).

**Invitación animada en el cuerpo, sin adjuntos**: una imagen adjunta no puede llevar links, así que la invitación va dentro del correo en tres piezas de `/brand/invitacion-correo/`: `arriba.gif` (logo y 40 con su brillo, 3.5 s), `centro.jpg` (título, 2027 y datos) y `abajo.gif` (leyendas, botón «Regístrese aquí» y logo de TaxPro animado, 7 s). Las tres van en una tabla de 564 px y cada una está ligada a `{{1.invitation_url}}`, así que cualquier clic en la invitación (y en particular en el botón) abre el registro personal del invitado. El escenario ya no tiene módulos HTTP ni adjuntos. El primer cuadro de cada GIF es idéntico a la invitación, porque Outlook de escritorio sólo muestra ese cuadro. Si cambia `invitacion.png`, hay que regenerar las piezas (cortes en y=276 y y=1124). Cada `<img>` lleva `height` (138, 424 y 132, la mitad exacta de cada pieza) y las celdas tienen fondo crema `#FBF8F1` con `mso-line-height-rule:exactly`: sin eso, Outlook de escritorio en Windows deja una línea blanca entre las piezas.

Los corchetes son referencias para insertar los campos dinámicos; no dejarlos como texto literal. Envía un mensaje por invitado, con su propio enlace.

## 5. Devolver el resultado

Después del módulo de correo agrega **Webhooks → Webhook response**:

- Status: `200`
- Body: `{"ok":true}`
- Custom headers: `Content-Type` = `application/json`

La respuesta debe ejecutarse después del envío exitoso. No configures una ruta de error que responda `ok: true`. El `Accepted` predeterminado de Make solo acredita recepción en la cola, no envío.

## 6. Guardar y probar

Guarda el escenario. Cuando esté conectada la función de Supabase, pulsa **Run once** y envía una invitación a tu propio correo. Comprueba la recepción, que el enlace funciona y que el panel registra el correo como enviado. Después activa el escenario para procesar solicitudes al webhook.

## Publicar la conexión con Supabase

La función `supabase/functions/send-invitation/index.ts` ya utiliza Make. En Supabase, crea o edita la Edge Function llamada exactamente `send-invitation`, sustituye todo el contenido de `index.ts` por el archivo del repositorio y pulsa Deploy. Conserva la verificación JWT habilitada; además, el código valida la sesión y el rol de administrador del evento.

La función envía los campos anteriores a Make y exige un JSON con `ok: true` antes de actualizar el correo. No vuelve a enviar una invitación que ya tiene `sent_at` o estado `sent`. Esto no constituye una cola ni garantiza exclusión entre dos solicitudes simultáneas; no ejecutar envíos concurrentes para el mismo invitado.

Si la conexión se interrumpe, la respuesta es `Accepted`, hay un error o se agota la espera de 25 segundos, no se marca como enviado. Revisa el historial de Make antes de volver a pulsar Enviar: el escenario podría haber continuado. Si el correo salió pero falló el guardado en Supabase, reconcilia su estado antes de reintentar.

Prueba desde el panel del evento con sesión de administrador y tu propio correo, con Make en Run once. El botón Test de Supabase no sustituye la sesión de usuario que requiere esta función. Después activa el escenario de Make.

La URL y clave del webhook deben guardarse en secretos de Supabase como `MAKE_WEBHOOK_URL` y `MAKE_WEBHOOK_API_KEY`; nunca en variables `VITE_*`. `PUBLIC_SITE_URL` debe apuntar al dominio publicado. No compartas claves en el repositorio.

WhatsApp tiene un control separado: abrir el mensaje, enviarlo manualmente y pulsar **Marcar WhatsApp enviado**. No necesita Router, conexión con Meta ni un módulo de WhatsApp en Make.

## Recordatorios para invitados sin respuesta

El panel muestra **Enviar recordatorio** junto al correo sólo si ese correo ya recibió la invitación y el RSVP sigue pendiente. La función vuelve a consultar el RSVP antes del envío: si ya confirmó o canceló, rechaza el recordatorio. Se reutiliza el enlace personal.

Para activar el correo de recordatorio, crea **otro escenario de Make** con el mismo flujo `Custom webhook → Send an email → Webhook response`. Usa como asunto `Ruvalcaba Villalobos | Reformas fiscales 2027 · Nos dará gusto contar con su presencia` y como contenido HTML [recordatorio-make.html](../emails/recordatorio-make.html). Configura el destinatario como `{{1.email}}` y conserva la variable `{{1.invitation_url}}` (el saludo ahora es fijo: «Estimados clientes y amigos:»). La respuesta `{"ok":true}` debe ocurrir sólo después de que el módulo de correo termine correctamente. Guarda la URL del nuevo webhook en el secreto `MAKE_REMINDER_WEBHOOK_URL` de Supabase; puede usar la misma clave `MAKE_WEBHOOK_API_KEY` si habilitas esa clave también en el nuevo webhook. Publica la función `send-invitation` actualizada y prueba con un contacto de prueba cuyo correo figure enviado y cuyo RSVP siga pendiente. Sin el nuevo secreto, la función rechaza el recordatorio antes de llamar a Make.

En WhatsApp aparece **Abrir recordatorio en WhatsApp** cuando hay un envío previo registrado por cualquier canal y el RSVP sigue pendiente. El texto queda precargado, pero la persona que opera debe enviarlo manualmente. Antes de usarlo conviene actualizar la lista: WhatsApp no puede volver a verificar el RSVP después de abrir el chat.

## Entrada por correo al confirmar asistencia

Cuando un invitado confirma desde su enlace (o un administrador lo marca como confirmado en el panel), el sitio llama a la función `send-ticket`. La función genera la misma entrada en PDF que se descarga desde la página, con su QR, y la manda a Make para que salga por correo como adjunto. Sólo se envía si el RSVP está confirmado, al correo registrado del invitado y una sola vez (queda en `invitations.ticket_sent_at`). Si Make no responde `{"ok":true}`, se libera para que un siguiente intento la vuelva a mandar. Si el invitado no tiene correo, no se envía nada; sigue pudiendo descargarla desde la página.

Si el invitado cancela una asistencia confirmada (desde su enlace o desde el panel), un trigger en `rsvps` pone `ticket_sent_at` en nulo, así que al volver a confirmar le llega una entrada nueva. Los administradores también pueden usar **Reenviar entrada** en el menú ⋯ de un invitado confirmado con correo: llama a `release_guest_ticket_email` (sólo admins) y luego a `send-ticket`. Ambos están en `supabase/migrations/20261113190000_ticket_resend_after_cancel.sql`.

### 1. Base de datos

Pega en el SQL Editor de Supabase el contenido de `supabase/migrations/20261112120000_ticket_email.sql` y ejecútalo.

### 2. Escenario de Make

Crea un escenario nuevo **RV Reformas fiscales 2027 - Enviar entrada** con `Custom webhook → Send an email → Webhook response`:

- **Webhook**: nombre `rv_enviar_entrada`, con API Key authentication (puede ser la misma clave `MAKE_WEBHOOK_API_KEY`). Campos: `invitation_id`, `guest_name`, `greeting`, `email`, `ticket_url`, `ticket_qr_url`, `ticket_filename`, `ticket_pdf` (este último es el PDF en base64).
- **Email**: Microsoft 365 Email (Outlook) → Send an Email, con la misma conexión que la invitación (el escenario se creó clonando el de la invitación):
  - To: `{{1.email}}`
  - Subject: `Su entrada · Reformas fiscales 2027 · Ruvalcaba Villalobos`
  - Content: HTML de [entrada-make.html](../emails/entrada-make.html): el texto corto y la entrada abierta dentro del correo (usa `{{1.guest_name}}` y `{{1.ticket_qr_url}}`, la imagen del QR que sirve `send-ticket` con `GET ?qr=TOKEN` sólo si la asistencia está confirmada).
  - Attachments → Add item: File Name `{{1.ticket_filename}}`, Data `{{toBinary(1.ticket_pdf; base64)}}` (máximo 3 MB por archivo; la entrada pesa mucho menos).
- **Webhook response**: Status `200`, Body `{"ok":true}`, header `Content-Type` = `application/json`, sólo después del correo.

### 3. Función de Supabase

Crea la Edge Function **`send-ticket`** con el contenido de `supabase/functions/send-ticket/index.ts` y **desactiva "Verify JWT"**: el invitado no tiene sesión y su token personal es la credencial. Agrega el secreto `MAKE_TICKET_WEBHOOK_URL` con la URL del webhook nuevo (usa también `MAKE_WEBHOOK_API_KEY` y `PUBLIC_SITE_URL`, que ya existen).

### 4. Probar

Con Make en **Run once**, confirma la asistencia de un invitado de prueba con tu correo. Revisa que llegue el correo con el PDF adjunto, que el QR se lea en **Registro en evento** y que el botón abra la página de la entrada. Para volver a probar con el mismo invitado, pon `ticket_sent_at` en nulo en su invitación.

## Documentación oficial

- [Webhooks y respuestas en Make](https://apps.make.com/gateway)
- [Módulos de Gmail](https://apps.make.com/gmail-modules)
- [Secretos de Supabase](https://supabase.com/docs/guides/functions/secrets)

## Correo de GoDaddy utilizado en este proyecto

En lugar de Gmail, usa **Email → Send an Email** con **Others (SMTP)**. Configura `smtpout.secureserver.net`, puerto `465`, conexión segura activada y STARTTLS explícito desactivado. Usa como usuario la dirección completa del buzón y su contraseña (o la contraseña de aplicación, si la cuenta la requiere). El destinatario es `{{1.email}}`; el contenido HTML utiliza `{{1.greeting}}` y `{{1.invitation_url}}`. Comprueba que Make reconozca los campos como variables.

[Configuración oficial de GoDaddy](https://www.godaddy.com/en-ca/help/use-imap-settings-to-add-my-professional-email-to-a-client-32204).

## Envíos masivos pausados (desde el 2026-11-17)

El 2026-11-17 Microsoft 365 restringió la cuenta remitente tras una ráfaga de invitaciones: desde ese momento todo correo rebotó con `550 5.1.8 Access denied, bad outbound sender`. Outlook acepta el correo antes de rechazarlo, así que Make respondió `ok` y la base los dejó como enviados. Para no repetirlo, los tres envíos masivos del panel («Enviar todas las invitaciones», «Enviar todos los recordatorios» y «Enviar entradas pendientes») mandan un correo cada 15 s (`BULK_EMAIL_PAUSE_MS` en `src/lib/invitations.ts`, unos 240 por hora), piden confirmación con el tiempo estimado y tienen «Detener envío». «Enviar entradas pendientes» (sólo administradores) manda la entrada a los confirmados cuyo `ticket_sent_at` es nulo; `send-ticket` sigue siendo idempotente. Si la cuenta vuelve a quedar restringida, la desbloquea un administrador de Microsoft 365 en Microsoft Defender → Restricted entities, y los envíos rebotados se liberan con SQL (estado `bounced`, `sent_at` y `ticket_sent_at` en nulo) antes de reenviar.

## Bitácora de rebotes (desde el 2026-11-18)

Los avisos de «correo no entregado» que llegan a la bandeja del remitente se registran en `public.email_bounces` (migración `20261118090000_email_bounces.sql`) y se ven en el panel, en **Bitácora → Entradas** (estado de la entrada de cada confirmado: enviada, rebotó, reenviada, pendiente) y **Bitácora → Rebotes** (cada aviso con su motivo y qué hacer). Si en las últimas 12 horas hubo un rebote por bloqueo de la cuenta, la lista de invitados y la bitácora muestran un aviso y los envíos masivos lo repiten antes de confirmar.

Escenario de Make **«RV Reformas fiscales 2027 - Registrar rebotes»**:

1. **Microsoft 365 Email → Watch Emails**, con la misma conexión de Outlook que los demás escenarios, carpeta Bandeja de entrada, «From now on».
2. **Filtro** (entre módulos): el asunto contiene `Undeliverable`, `No se puede entregar`, `Delivery Status Notification` o `no entregado`, o el remitente contiene `MicrosoftExchange`, `postmaster` o `mailer-daemon`.
3. **HTTP → Make a request**: `POST https://mezagevywxydmjcucxej.supabase.co/rest/v1/rpc/record_email_bounce`, encabezados `apikey: <publishable key>` y `Content-Type: application/json`, cuerpo JSON (armado con el módulo JSON → Create JSON para que el HTML del aviso quede escapado):
   `{"secret": "<clave de private.bounce_webhook_secret>", "subject": {{subject}}, "body": {{body content}}, "received_at": {{receivedDateTime}}, "message_id": {{internetMessageId}}}`

La función responde `{"status":"ok", "kind", "reason", "released", …}`, `duplicate` si el aviso ya estaba, `no_recipient` si no encontró a quién iba y `forbidden` si la clave no coincide. La clave no está en el repo: se carga una sola vez con `insert into private.bounce_webhook_secret(secret) values ('…')`.

Qué hace con cada aviso: reconoce si era invitación, entrada o recordatorio (por el asunto del aviso o el asunto original citado) y el motivo (`cuenta_bloqueada` con 5.1.8, `direccion_invalida` con 5.1.1/5.1.10/«no se encontró», `rechazado` en otro caso). Si el destinatario está en la lista y el motivo no es una dirección inexistente, libera el envío (`sent_at`/`ticket_sent_at`/`reminder_sent_at` en nulo; la invitación queda con estado `bounced`) para que el envío masivo correspondiente lo vuelva a mandar. Un aviso viejo no libera un reenvío posterior (sólo se libera si el envío es anterior al aviso, con 2 minutos de margen). No se libera la invitación de quien ya respondió.
