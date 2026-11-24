import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../supabase/functions/process-email-queue/index.ts', import.meta.url), 'utf8').replace(/^import .*\n/, '')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
const secret = 'x'.repeat(40)

function setup({ claim = { result: 'idle' }, claimError = null, makeResponse = { ok: true }, makeStatus = 200, ticketResponse = { ok: true }, ticketStatus = 200, env = {} } = {}) {
  let handler
  const calls = { finish: [], fetch: [] }
  const allEnv = { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_ANON_KEY: 'public', SUPABASE_SERVICE_ROLE_KEY: 'service', MAKE_WEBHOOK_URL: 'https://hook.make.com/inv', MAKE_REMINDER_WEBHOOK_URL: 'https://hook.make.com/rem', MAKE_WEBHOOK_API_KEY: 'k', PUBLIC_SITE_URL: 'https://evento.example.com', ...env }
  const createClient = (_url, key) => {
    assert.equal(key, 'service')
    return { rpc: async (name, args) => {
      assert.equal(args.p_secret, secret)
      if (name === 'claim_email_queue_item') return { data: claim, error: claimError }
      assert.equal(name, 'finish_email_queue_item')
      calls.finish.push(JSON.parse(JSON.stringify(args)))
      return { data: { result: 'ok' }, error: null }
    } }
  }
  const fetch = async (url, init) => {
    calls.fetch.push({ url, body: JSON.parse(init.body), headers: init.headers })
    const ticket = url.endsWith('/functions/v1/send-ticket')
    return new Response(JSON.stringify(ticket ? ticketResponse : makeResponse), { status: ticket ? ticketStatus : makeStatus })
  }
  vm.runInNewContext(compiled, { createClient, fetch, URL, Response, AbortSignal, JSON, console: { error() {} }, Deno: { env: { get: key => allEnv[key] }, serve: fn => { handler = fn } } })
  const call = body => handler(new Request('https://x/functions/v1/process-email-queue', { method: 'POST', body: JSON.stringify(body) }))
  return { call, calls }
}

test('sin la clave no toca la cola; con la clave mala la base lo rechaza', async () => {
  const { call, calls } = setup()
  assert.equal((await call({})).status, 401)
  assert.equal((await call({ secret: 'corta' })).status, 401)
  const denied = setup({ claimError: { code: '42501' } })
  assert.equal((await denied.call({ secret })).status, 401)
  assert.equal(calls.fetch.length + denied.calls.fetch.length, 0)
})

test('sin correos en fila o esperando turno no manda nada', async () => {
  for (const result of ['idle', 'wait', 'busy']) {
    const { call, calls } = setup({ claim: { result } })
    assert.deepEqual(await (await call({ secret })).json(), { ok: true, result })
    assert.equal(calls.fetch.length, 0)
    assert.equal(calls.finish.length, 0)
  }
})

test('manda la invitación a Make con el enlace general y la marca como enviada', async () => {
  const { call, calls } = setup({ claim: { result: 'claimed', id: 7, kind: 'invitacion', email: 'ana@x.com', full_name: '<Ana>', invitation_id: 'inv-1', token: 't' } })
  await call({ secret })
  assert.equal(calls.fetch[0].url, 'https://hook.make.com/inv')
  assert.equal(calls.fetch[0].headers['x-make-apikey'], 'k')
  assert.deepEqual(calls.fetch[0].body, { invitation_id: 'inv-1', guest_name: '&lt;Ana&gt;', greeting: 'Estimado(a) &lt;Ana&gt;:', email: 'ana@x.com', invitation_url: 'https://evento.example.com/' })
  assert.deepEqual(calls.finish, [{ p_secret: secret, p_item: 7, p_outcome: 'sent', p_detail: null }])
})

test('el recordatorio va al webhook de recordatorios; si Make no confirma, el lote se detiene', async () => {
  const { call, calls } = setup({ claim: { result: 'claimed', id: 8, kind: 'recordatorio', email: 'b@x.com', full_name: null, invitation_id: 'inv-2' }, makeResponse: { accepted: true } })
  await call({ secret })
  assert.equal(calls.fetch[0].url, 'https://hook.make.com/rem')
  assert.equal(calls.fetch[0].body.reminder, true)
  assert.equal(calls.fetch[0].body.greeting, 'Reciba un cordial saludo.')
  assert.equal(calls.finish[0].p_outcome, 'failed')
  assert.match(calls.finish[0].p_detail, /^b@x.com: no se confirmó el envío del recordatorio/)
})

test('sin Secrets de Make no manda y detiene el lote', async () => {
  const { call, calls } = setup({ claim: { result: 'claimed', id: 9, kind: 'invitacion', email: 'a@x.com' }, env: { MAKE_WEBHOOK_URL: '' } })
  await call({ secret })
  assert.equal(calls.fetch.length, 0)
  assert.equal(calls.finish[0].p_outcome, 'failed')
})

test('las entradas se piden a send-ticket con el token de la invitación', async () => {
  const claim = { result: 'claimed', id: 10, kind: 'entrada', email: 'c@x.com', token: 'tok-1' }
  const sent = setup({ claim })
  await sent.call({ secret })
  assert.equal(sent.calls.fetch[0].url, 'https://test.supabase.co/functions/v1/send-ticket')
  assert.deepEqual(sent.calls.fetch[0].body, { token: 'tok-1' })
  assert.equal(sent.calls.fetch[0].headers.Authorization, 'Bearer public')
  assert.equal(sent.calls.finish[0].p_outcome, 'sent')
  const already = setup({ claim, ticketResponse: { ok: true, already_sent: true } })
  await already.call({ secret })
  assert.equal(already.calls.finish[0].p_outcome, 'omitted')
  const notConfirmed = setup({ claim, ticketStatus: 409, ticketResponse: { error: 'La asistencia no está confirmada' } })
  await notConfirmed.call({ secret })
  assert.deepEqual([notConfirmed.calls.finish[0].p_outcome, notConfirmed.calls.finish[0].p_detail], ['omitted', 'La asistencia no está confirmada'])
  const failed = setup({ claim, ticketStatus: 502, ticketResponse: { error: 'No se confirmó' } })
  await failed.call({ secret })
  assert.equal(failed.calls.finish[0].p_outcome, 'failed')
})
