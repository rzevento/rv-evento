import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bounceAdvice, recentAccountBlock, ticketState } from '../src/lib/email-log.ts'
import type { EmailBounce } from '../src/lib/email-log.ts'

const bounce = (over: Partial<EmailBounce> = {}): EmailBounce => ({ id: 1, bouncedAt: '2026-11-17T22:30:24Z', email: 'a@x.com', guestId: 'g1', guestName: 'A', kind: 'entrada', reason: 'cuenta_bloqueada', detail: '', released: true, ...over })

test('estado de la entrada según el envío y el último rebote', () => {
  const guest = { guestId: 'g1', email: 'a@x.com', ticketSentAt: null as string | null }
  assert.equal(ticketState(guest, []).state, 'pendiente')
  assert.equal(ticketState({ ...guest, ticketSentAt: '2026-11-17T20:00:00Z' }, []).state, 'enviada')
  // Rebotó y se liberó (ticket_sent_at en nulo).
  assert.equal(ticketState(guest, [bounce()]).state, 'rebotada')
  // Rebotó por dirección inexistente: el envío sigue registrado, pero es el que rebotó.
  assert.equal(ticketState({ ...guest, ticketSentAt: '2026-11-17T22:30:20Z' }, [bounce({ reason: 'direccion_invalida', released: false })]).state, 'rebotada')
  // Reenvío después del rebote.
  assert.equal(ticketState({ ...guest, ticketSentAt: '2026-11-18T18:00:00Z' }, [bounce()]).state, 'reenviada')
  // Rebotes de otro invitado o de la invitación no cuentan.
  assert.equal(ticketState({ ...guest, ticketSentAt: '2026-11-17T20:00:00Z' }, [bounce({ guestId: 'g2' }), bounce({ kind: 'invitacion' })]).state, 'enviada')
  assert.equal(ticketState({ ...guest, email: ' ' }, [bounce()]).state, 'sin_correo')
})

test('aviso de bloqueo sólo con rebotes recientes por la cuenta remitente', () => {
  const now = new Date('2026-11-18T02:00:00Z').getTime()
  assert.equal(recentAccountBlock([bounce()], now)?.id, 1)
  assert.equal(recentAccountBlock([bounce({ reason: 'direccion_invalida' })], now), null)
  assert.equal(recentAccountBlock([bounce({ bouncedAt: '2026-11-16T10:00:00Z' })], now), null)
  assert.equal(recentAccountBlock([{ id: 'x', status: 'Confirmado' }], now), null)
  assert.equal(recentAccountBlock(undefined, now), null)
})

test('qué hacer con cada rebote', () => {
  assert.match(bounceAdvice(bounce({ reason: 'direccion_invalida', released: false })), /Corrige el correo/)
  assert.match(bounceAdvice(bounce()), /Enviar entradas pendientes/)
  assert.match(bounceAdvice(bounce({ kind: 'invitacion' })), /Enviar todas las invitaciones/)
  assert.match(bounceAdvice(bounce({ kind: 'invitacion', released: false })), /ya respondió/)
  assert.match(bounceAdvice(bounce({ guestId: null })), /no está en la lista/)
  assert.match(bounceAdvice(bounce({ reason: 'rechazado', released: false })), /lo rechazó/)
})
