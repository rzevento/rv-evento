export type BounceKind = 'invitacion' | 'entrada' | 'recordatorio' | 'otro'
export type BounceReason = 'cuenta_bloqueada' | 'direccion_invalida' | 'rechazado'
export type EmailBounce = { id: number; bouncedAt: string; email: string; guestId: string | null; guestName: string | null; kind: BounceKind; reason: BounceReason; detail: string; released: boolean }
export type TicketLogEntry = { guestId: string; name: string; email: string; company: string; confirmedAt: string | null; ticketSentAt: string | null; token: string | null }
export type TicketState = 'enviada' | 'reenviada' | 'rebotada' | 'pendiente' | 'sin_correo'

export const bounceKindLabels: Record<BounceKind, string> = { invitacion: 'Invitación', entrada: 'Entrada', recordatorio: 'Recordatorio', otro: 'Otro correo' }
export const bounceReasonLabels: Record<BounceReason, string> = {
  cuenta_bloqueada: 'Cuenta remitente bloqueada',
  direccion_invalida: 'La dirección no existe',
  rechazado: 'Lo rechazó el destinatario',
}
export const ticketStateLabels: Record<TicketState, string> = {
  enviada: 'Enviada',
  reenviada: 'Reenviada tras rebote',
  rebotada: 'Rebotó',
  pendiente: 'Pendiente de envío',
  sin_correo: 'Sin correo',
}

// Igual que en la base (private.apply_email_bounce): un envío registrado hasta 2 minutos después del aviso
// es el mismo que rebotó; uno posterior es un reenvío.
const BOUNCE_MARGIN_MS = 2 * 60_000
const time = (value: string) => new Date(value).getTime()

export function latestBounce(bounces: EmailBounce[], guestId: string, kind: BounceKind): EmailBounce | null {
  return bounces.filter(b => b.guestId === guestId && b.kind === kind).reduce<EmailBounce | null>((latest, b) => !latest || time(b.bouncedAt) > time(latest.bouncedAt) ? b : latest, null)
}

export function ticketState(entry: Pick<TicketLogEntry, 'guestId' | 'email' | 'ticketSentAt'>, bounces: EmailBounce[]): { state: TicketState; at: string | null; bounce: EmailBounce | null } {
  const bounce = latestBounce(bounces, entry.guestId, 'entrada')
  if (!entry.email.trim()) return { state: 'sin_correo', at: null, bounce }
  if (entry.ticketSentAt && (!bounce || time(entry.ticketSentAt) > time(bounce.bouncedAt) + BOUNCE_MARGIN_MS)) return { state: bounce ? 'reenviada' : 'enviada', at: entry.ticketSentAt, bounce }
  if (bounce) return { state: 'rebotada', at: bounce.bouncedAt, bounce }
  return { state: 'pendiente', at: null, bounce: null }
}

export function bounceAdvice(bounce: EmailBounce): string {
  if (bounce.reason === 'direccion_invalida') return bounce.guestId ? 'Corrige el correo del invitado y vuelve a enviar.' : 'Esta dirección no está en la lista de invitados.'
  if (!bounce.guestId) return 'Esta dirección no está en la lista de invitados.'
  if (bounce.released) return bounce.kind === 'entrada' ? 'Quedó pendiente: sale con «Enviar entradas pendientes».' : bounce.kind === 'invitacion' ? 'Quedó pendiente: sale con «Enviar todas las invitaciones».' : bounce.kind === 'recordatorio' ? 'Quedó pendiente: sale con «Enviar todos los recordatorios».' : 'Revisa el correo en la bandeja del remitente.'
  if (bounce.kind === 'invitacion') return 'No se volverá a enviar: ya respondió o ya se había reenviado.'
  return 'No se liberó: ya se había reenviado.'
}

/** Rebote más reciente por bloqueo de la cuenta remitente en las últimas horas, para avisar antes de enviar. */
export function recentAccountBlock(bounces: unknown, now = Date.now(), withinHours = 12): EmailBounce | null {
  if (!Array.isArray(bounces)) return null
  const recent = (bounces as Partial<EmailBounce>[]).filter((b): b is EmailBounce => b?.reason === 'cuenta_bloqueada' && typeof b.bouncedAt === 'string' && now - time(b.bouncedAt) <= withinHours * 3_600_000)
  return recent.reduce<EmailBounce | null>((latest, b) => !latest || time(b.bouncedAt) > time(latest.bouncedAt) ? b : latest, null)
}

export function blockWarning(bounce: EmailBounce | null): string {
  if (!bounce) return ''
  const at = new Date(bounce.bouncedAt).toLocaleString('es-MX', { timeZone: 'America/Mexico_City', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
  return `Outlook está rechazando los correos porque Microsoft bloqueó la cuenta remitente (último rebote: ${at}). Mientras no la desbloqueen, todo lo que se envíe va a rebotar. Si ya la desbloquearon, ignora este aviso.`
}
