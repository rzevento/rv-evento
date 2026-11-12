import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../supabase/functions/send-ticket/index.ts', import.meta.url), 'utf8').replace(/^import .*$/gm, '')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
const invitationId = '00000000-0000-0000-0000-000000000001'

class FakePdf {
  internal = { pageSize: { getWidth: () => 210 } }
  splitTextToSize(text) { return [text] }
  getTextWidth(text) { return text.length * 2 }
  output() { return new Uint8Array([37, 80, 68, 70]).buffer }
}
for (const method of ['setFillColor', 'rect', 'addImage', 'setTextColor', 'setFont', 'setFontSize', 'text', 'setDrawColor', 'setLineWidth', 'line']) FakePdf.prototype[method] = () => {}

function setup(options = {}) {
  let handler, payload
  const calls = { claims: 0, releases: 0, sends: 0 }
  const env = { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'secret', MAKE_TICKET_WEBHOOK_URL: 'https://hook.make.com/ticket', MAKE_WEBHOOK_API_KEY: 'test-key', PUBLIC_SITE_URL: 'https://evento.example.com', ...options.env }
  const createClient = (_url, key) => {
    assert.equal(key, 'secret')
    return {
      rpc: async (name, args) => {
        if (name === 'release_ticket_email') { calls.releases++; assert.equal(args.target_invitation_id, invitationId); return { error: null } }
        assert.equal(name, 'claim_ticket_email'); assert.equal(args.invitation_token, 'abc123token'); calls.claims++
        return { data: { result: options.claim || 'claimed', invitation_id: invitationId, guest_name: 'fullName' in options ? options.fullName : '<Ana>', email: 'ana@example.com' }, error: null }
      },
    }
  }
  vm.runInNewContext(compiled, {
    createClient, jsPDF: FakePdf, QRCode: { toDataURL: async () => 'data:image/png;base64,AA==' },
    URL, Response, AbortSignal, btoa, Uint8Array, String, console: { error() {} },
    Deno: { env: { get: key => env[key] }, serve: fn => { handler = fn } },
    fetch: async (url, init) => {
      if (url.endsWith('/brand/rv-logo.png')) return new Response(new Uint8Array([1, 2, 3]))
      calls.sends++; assert.equal(url, env.MAKE_TICKET_WEBHOOK_URL); assert.equal(init.headers['x-make-apikey'], 'test-key')
      payload = JSON.parse(init.body)
      if (options.timeout) throw new Error('timeout')
      return new Response(options.reply ?? '{"ok":true}', { status: 200 })
    },
  })
  const call = (body = { token: 'abc123token' }) => handler(new Request('https://test/fn', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }))
  return { call, calls, payload: () => payload }
}

test('rechaza tokens inválidos sin consultar ni enviar', async () => {
  for (const body of ['{bad', { token: '' }, { token: 'a b' }, {}]) {
    const app = setup(); assert.equal((await app.call(body)).status, 400); assert.deepEqual(app.calls, { claims: 0, releases: 0, sends: 0 })
  }
})

test('envía a Make la entrada en PDF con saludo y enlace', async () => {
  const app = setup(); const response = await app.call()
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true })
  assert.deepEqual(app.calls, { claims: 1, releases: 0, sends: 1 })
  assert.deepEqual(app.payload(), {
    invitation_id: invitationId, guest_name: '&lt;Ana&gt;', greeting: 'Estimado(a) &lt;Ana&gt;:', email: 'ana@example.com',
    ticket_url: 'https://evento.example.com/registro/abc123token', ticket_filename: 'entrada-reformas-fiscales-2027.pdf', ticket_pdf: 'JVBERg==',
  })
})

test('no envía si ya se mandó, no hay correo o no está confirmado', async () => {
  for (const [claim, status] of [['already_sent', 200], ['no_email', 200], ['not_confirmed', 409], ['not_found', 404]]) {
    const app = setup({ claim }); assert.equal((await app.call()).status, status); assert.equal(app.calls.sends, 0); assert.equal(app.calls.releases, 0)
  }
})

test('libera el envío si Make no confirma', async () => {
  for (const options of [{ reply: 'Accepted' }, { timeout: true }]) {
    const app = setup(options); assert.equal((await app.call()).status, 502); assert.equal(app.calls.releases, 1)
  }
})

test('saludo neutro sin nombre y error de configuración sin webhook', async () => {
  const app = setup({ fullName: null }); await app.call(); assert.equal(app.payload().greeting, 'Reciba un cordial saludo.')
  const missing = setup({ env: { MAKE_TICKET_WEBHOOK_URL: '' } }); assert.equal((await missing.call()).status, 500); assert.equal(missing.calls.claims, 0)
})
