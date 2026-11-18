import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Send } from 'lucide-react'
import { releaseGuestTicket, sendTicket } from '../lib/supabase'
import { bounceAdvice, bounceKindLabels, bounceReasonLabels, ticketState, ticketStateLabels } from '../lib/email-log'
import type { EmailBounce, TicketLogEntry, TicketState } from '../lib/email-log'

const formatDate = (value: string | null) => value ? new Date(value).toLocaleString('es-MX', { timeZone: 'America/Mexico_City', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—'

export function ticketRows(tickets: TicketLogEntry[], bounces: EmailBounce[]) {
  return tickets.map(entry => ({ entry, ...ticketState(entry, bounces) }))
}

export const ticketCsv = (tickets: TicketLogEntry[], bounces: EmailBounce[]) => [
  ['confirmó', 'nombre', 'correo', 'empresa', 'entrada', 'hora', 'motivo del rebote'],
  ...ticketRows(tickets, bounces).map(r => [formatDate(r.entry.confirmedAt), r.entry.name, r.entry.email, r.entry.company, ticketStateLabels[r.state], formatDate(r.at), r.state === 'rebotada' && r.bounce ? bounceReasonLabels[r.bounce.reason] : '']),
]

export const bounceCsv = (bounces: EmailBounce[]) => [
  ['fecha', 'correo', 'invitado', 'correo rebotado', 'motivo', 'qué hacer', 'detalle del servidor'],
  ...bounces.map(b => [formatDate(b.bouncedAt), b.email, b.guestName || '', bounceKindLabels[b.kind], bounceReasonLabels[b.reason], bounceAdvice(b), b.detail]),
]

export function TicketLogTable({ tickets, bounces, filter, canResend, onNotice, onError }: { tickets: TicketLogEntry[]; bounces: EmailBounce[]; filter: 'all' | 'problems'; canResend: boolean; onNotice: (message: string) => void; onError: (message: string) => void }) {
  const queryClient = useQueryClient()
  const [sending, setSending] = useState<string | null>(null)
  const problems: TicketState[] = ['rebotada', 'pendiente']
  const rows = ticketRows(tickets, bounces).filter(r => filter === 'all' || problems.includes(r.state))
  async function resend(entry: TicketLogEntry) {
    if (!entry.token) { onError(`No se encontró la invitación de ${entry.name}.`); return }
    setSending(entry.guestId)
    onError('')
    onNotice('')
    try {
      const released = await releaseGuestTicket(entry.guestId)
      if (released.error) throw released.error
      const result = await sendTicket(entry.token)
      if (result.error) throw result.error
      onNotice(`Se reenvió la entrada a ${entry.email}. Si rebota, el aviso «Undeliverable» llega en uno o dos minutos a la bandeja de Reformas Fiscales.`)
      await queryClient.invalidateQueries({ queryKey: ['ticket-log'] })
    } catch (cause) {
      onError(`No se pudo reenviar la entrada a ${entry.email}: ${cause instanceof Error ? cause.message : 'error desconocido'}`)
    } finally { setSending(null) }
  }
  return <>
    <div className="emaillog-head emaillog-tickets"><span>CONFIRMÓ</span><span>PERSONA</span><span>ENTRADA POR CORREO</span><span>DETALLE</span><span></span></div>
    {rows.length === 0 ? <p className="guest-list-empty">{filter === 'problems' ? 'Todas las entradas se enviaron sin rebotes.' : 'Aún no hay invitados confirmados.'}</p>
      : rows.map(({ entry, state, at, bounce }) => <div className="emaillog-line emaillog-tickets" key={entry.guestId}>
        <span className="reglog-date">{formatDate(entry.confirmedAt)}</span>
        <span className="reglog-person"><strong>{entry.name}</strong><small>{entry.email || 'Sin correo'}{entry.company ? ` · ${entry.company}` : ''}</small></span>
        <span className={`emaillog-state emaillog-${state}`}>{ticketStateLabels[state]}{at && <small>{formatDate(at)}</small>}</span>
        <span className="reglog-detail">{state === 'rebotada' && bounce ? `${bounceReasonLabels[bounce.reason]}. ${bounceAdvice(bounce)}` : state === 'reenviada' && bounce ? `Rebotó el ${formatDate(bounce.bouncedAt)} (${bounceReasonLabels[bounce.reason].toLowerCase()}).` : state === 'pendiente' ? 'Aún no sale el correo con su entrada.' : ''}</span>
        <span className="reglog-actions">{canResend && entry.email && <button className="row-action" disabled={sending !== null} onClick={() => void resend(entry)}><Send size={14} /> {sending === entry.guestId ? 'Enviando…' : state === 'enviada' || state === 'reenviada' ? 'Reenviar' : 'Enviar entrada'}</button>}</span>
      </div>)}
  </>
}

export function BounceLogTable({ bounces }: { bounces: EmailBounce[] }) {
  return <>
    <div className="emaillog-head emaillog-bounces"><span>FECHA</span><span>DESTINATARIO</span><span>CORREO</span><span>MOTIVO</span><span>QUÉ HACER</span></div>
    {bounces.length === 0 ? <p className="guest-list-empty">No hay correos rebotados.</p>
      : bounces.map(b => <div className="emaillog-line emaillog-bounces" key={b.id}>
        <span className="reglog-date">{formatDate(b.bouncedAt)}</span>
        <span className="reglog-person"><strong>{b.guestName || 'No está en la lista'}</strong><small>{b.email}</small></span>
        <span>{bounceKindLabels[b.kind]}</span>
        <span className={`emaillog-reason emaillog-${b.reason}`} title={b.detail}>{bounceReasonLabels[b.reason]}</span>
        <span className="reglog-detail">{bounceAdvice(b)}</span>
      </div>)}
  </>
}
