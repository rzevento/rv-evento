import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emailBatchProgress, isEmailBatchActive, parseEmailBatchStatus } from '../src/lib/email-queue.ts'

const row = {
  id: 'b1', kind: 'entrada', created_at: '2026-11-23T20:00:00Z', created_by_name: 'Sandra', stopped_at: null, stop_reason: null, last_activity: '2026-11-23T20:01:00Z',
  counts: { total: 5, queued: 3, sending: 1, sent: 1, omitted: 0, rejected: 0, failed: 0, cancelled: 0 }, problems: [],
}

test('server bulk send status parses the RPC row and reports progress with remaining time', () => {
  const batch = parseEmailBatchStatus(row)!
  assert.equal(isEmailBatchActive(batch), true)
  assert.equal(emailBatchProgress(batch), 'Enviando entradas desde el servidor: 1 de 5, un correo cada 15 s (faltan unos 1 min). Puedes cambiar de página o cerrar el panel; el envío sigue.')
  assert.equal(parseEmailBatchStatus(null), null)
})

test('finished send summarizes sent, omitted and problem emails', () => {
  const batch = parseEmailBatchStatus({ ...row, kind: 'recordatorio', counts: { total: 6, queued: 0, sending: 0, sent: 3, omitted: 2, rejected: 1, failed: 0, cancelled: 0 } })!
  assert.equal(isEmailBatchActive(batch), false)
  assert.equal(emailBatchProgress(batch), 'Envío de recordatorios terminado: 3 enviado(s), 2 omitido(s) porque ya no aplicaban, 1 con problema.')
})
