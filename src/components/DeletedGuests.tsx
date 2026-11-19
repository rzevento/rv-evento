import type { DeletedGuest } from '../lib/supabase'

const formatDate = (value: string | null) => value ? new Date(value).toLocaleString('es-MX', { timeZone: 'America/Mexico_City', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—'

const rsvpLabels: Record<string, string> = { confirmed: 'Había confirmado', cancelled: 'Había cancelado', declined: 'Había cancelado', pending: 'Sin respuesta' }

// Cómo estaba el invitado cuando se eliminó.
export function deletedState(entry: DeletedGuest) {
  const parts = [rsvpLabels[entry.rsvpStatus || 'pending'] || 'Sin respuesta']
  if (entry.rsvpStatus === 'confirmed' && entry.confirmedAt) parts[0] += ` (${formatDate(entry.confirmedAt)})`
  parts.push(entry.invitationSentAt ? `invitación enviada ${formatDate(entry.invitationSentAt)}` : entry.whatsappSentAt ? 'invitación enviada por WhatsApp' : 'sin invitación enviada')
  if (entry.checkedInAt) parts.push(`llegó al evento ${formatDate(entry.checkedInAt)}`)
  return parts.join(' · ')
}

export const deletedCsv = (entries: DeletedGuest[]) => [
  ['alta', 'eliminado', 'nombre', 'correo', 'celular', 'empresa', 'eliminado por', 'motivo', 'estado al eliminar'],
  ...entries.map(e => [formatDate(e.createdAt), formatDate(e.deletedAt), e.name, e.email, e.phone, e.company, e.deletedBy || '', e.reason || '', deletedState(e)]),
]

export function DeletedGuestsTable({ entries }: { entries: DeletedGuest[] }) {
  return <>
    <div className="emaillog-head emaillog-deleted"><span>ALTA</span><span>ELIMINADO</span><span>PERSONA</span><span>MOTIVO</span><span>ESTADO AL ELIMINAR</span></div>
    {entries.length === 0 ? <p className="guest-list-empty">No se ha eliminado ningún invitado.</p>
      : entries.map(e => <div className="emaillog-line emaillog-deleted" key={e.id}>
        <span className="reglog-date"><span className="deleted-label">Alta: </span>{formatDate(e.createdAt)}</span>
        <span className="emaillog-state"><span><span className="deleted-label">Eliminado: </span>{formatDate(e.deletedAt)}</span><small>{e.deletedBy ? `por ${e.deletedBy}` : 'desde la base de datos'}</small></span>
        <span className="reglog-person"><strong>{e.name || 'Sin nombre'}</strong><small>{[e.email, e.phone].filter(Boolean).join(' · ') || 'Sin contacto'}{e.company ? ` · ${e.company}` : ''}</small></span>
        <span className="reglog-detail">{e.reason || <span className="muted">Sin motivo</span>}</span>
        <span className="reglog-detail">{deletedState(e)}</span>
      </div>)}
  </>
}
