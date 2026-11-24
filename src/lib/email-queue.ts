/**
 * Envíos masivos desde el servidor (migración 20261123150000_email_queue). El panel sólo deja los correos
 * en fila; pg_cron + la función process-email-queue los mandan uno cada 15 s aunque se cierre la pestaña.
 */
export type EmailBatchKind = 'invitacion' | 'recordatorio' | 'entrada'

export type EmailBatchCounts = {
  total: number
  queued: number
  sending: number
  sent: number
  omitted: number
  rejected: number
  failed: number
  cancelled: number
}

export type EmailBatchStatus = {
  id: string
  kind: EmailBatchKind
  createdAt: string
  createdByName: string | null
  stoppedAt: string | null
  stopReason: string | null
  lastActivity: string | null
  counts: EmailBatchCounts
  problems: { email: string; status: 'rejected' | 'failed'; detail: string | null }[]
}

const nouns: Record<EmailBatchKind, [string, string]> = {
  invitacion: ['invitación', 'invitaciones'],
  recordatorio: ['recordatorio', 'recordatorios'],
  entrada: ['entrada', 'entradas'],
}

export function emailBatchNoun(kind: EmailBatchKind, plural = true): string {
  return nouns[kind][plural ? 1 : 0]
}

export function isEmailBatchActive(batch: EmailBatchStatus | null | undefined): boolean {
  return Boolean(batch && batch.counts.queued + batch.counts.sending > 0)
}

// Mismo formato que bulkDurationLabel (invitations.ts); sin importarlo para que el módulo se pruebe solo.
function remainingLabel(count: number): string {
  const minutes = Math.max(1, Math.ceil(count * 15 / 60))
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

export function emailBatchProgress(batch: EmailBatchStatus): string {
  const { counts } = batch
  const noun = emailBatchNoun(batch.kind)
  if (isEmailBatchActive(batch)) {
    const done = counts.total - counts.queued - counts.sending
    const left = counts.queued + counts.sending
    return `Enviando ${noun} desde el servidor: ${done} de ${counts.total}, un correo cada 15 s (faltan unos ${remainingLabel(left)}). Puedes cambiar de página o cerrar el panel; el envío sigue.`
  }
  const parts = [`${counts.sent} enviado(s)`]
  if (counts.omitted) parts.push(`${counts.omitted} omitido(s) porque ya no aplicaban`)
  if (counts.rejected + counts.failed) parts.push(`${counts.rejected + counts.failed} con problema`)
  if (counts.cancelled) parts.push(`${counts.cancelled} sin enviar`)
  const head = batch.stoppedAt ? `Envío de ${noun} detenido` : `Envío de ${noun} terminado`
  return `${head}: ${parts.join(', ')}.`
}

export function parseEmailBatchStatus(row: unknown): EmailBatchStatus | null {
  if (!row || typeof row !== 'object') return null
  const value = row as Record<string, unknown>
  const counts = (value.counts || {}) as Partial<EmailBatchCounts>
  const number = (key: keyof EmailBatchCounts) => Number(counts[key] || 0)
  return {
    id: String(value.id),
    kind: value.kind as EmailBatchKind,
    createdAt: String(value.created_at),
    createdByName: (value.created_by_name as string | null) || null,
    stoppedAt: (value.stopped_at as string | null) || null,
    stopReason: (value.stop_reason as string | null) || null,
    lastActivity: (value.last_activity as string | null) || null,
    counts: { total: number('total'), queued: number('queued'), sending: number('sending'), sent: number('sent'), omitted: number('omitted'), rejected: number('rejected'), failed: number('failed'), cancelled: number('cancelled') },
    problems: Array.isArray(value.problems) ? value.problems as EmailBatchStatus['problems'] : [],
  }
}
