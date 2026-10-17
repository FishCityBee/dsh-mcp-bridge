// TLS 1.3 with mutually pinned public keys. Electron's BoringSSL does not
// implement OpenSSL's external-PSK cipher suites. The random local token is
// used only to derive domain-separated signing keys, never as wire data.
import {createECDH, createHmac, createPrivateKey, createPublicKey, randomBytes, sign, timingSafeEqual} from 'node:crypto'

export const PIPE_PROTOCOL = 'tls-pinned-v3'

function der(tag, ...parts) {
  const body = Buffer.concat(parts)
  const length = body.length < 128 ? Buffer.from([body.length])
    : body.length < 256 ? Buffer.from([0x81, body.length]) : Buffer.from([0x82, body.length >> 8, body.length & 255])
  return Buffer.concat([Buffer.from([tag]), length, body])
}
const sequence = (...parts) => der(0x30, ...parts)
const algorithm = sequence(der(0x06, Buffer.from('2a8648ce3d040302', 'hex'))) // ecdsa-with-SHA256
const commonName = sequence(der(0x31, sequence(der(0x06, Buffer.from('550403', 'hex')), der(0x0c, Buffer.from('dsh-mcp-bridge')))))
const pem = (label, bytes) => `-----BEGIN ${label}-----\n${bytes.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`

function signingKey(secret, role) {
  const ecdh = createECDH('prime256v1')
  for (let counter = 0; ; counter++) {
    const seed = createHmac('sha256', secret).update(`${PIPE_PROTOCOL}:${role}:${counter}`).digest()
    try { ecdh.setPrivateKey(seed) } catch { continue } // P-256's order is slightly smaller than 2^256.
    const point = ecdh.getPublicKey()
    return createPrivateKey({format: 'jwk', key: {
      kty: 'EC', crv: 'P-256', d: seed.toString('base64url'),
      x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url'),
    }})
  }
}

function certificate(key) {
  // A small, self-signed X.509 envelope for TLS, generated entirely in memory.
  // Trust comes from the token-derived SPKI pin, rather than a public CA.
  const now = Date.now()
  const serial = randomBytes(16)
  serial[0] = (serial[0] & 0x7f) | 1
  const time = value => {
    const date = new Date(value)
    const encoded = date.toISOString().replace(/[-:T]/g, '').replace(/\.\d{3}Z$/, 'Z')
    return date.getUTCFullYear() < 2050 ? der(0x17, Buffer.from(encoded.slice(2))) : der(0x18, Buffer.from(encoded))
  }
  const tbs = sequence(der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, serial), algorithm, commonName,
    sequence(time(now - 86_400_000), time(now + 366 * 86_400_000)), commonName,
    createPublicKey(key).export({format: 'der', type: 'spki'}))
  return pem('CERTIFICATE', sequence(tbs, algorithm, der(0x03, Buffer.concat([Buffer.from([0]), sign('sha256', tbs, key)]))))
}

export function createPipeIdentity(secret, role) {
  if (!secret?.length || !['server', 'client'].includes(role)) throw new Error('INVALID_PIPE_IDENTITY')
  const key = signingKey(secret, role)
  const peer = createPublicKey(signingKey(secret, role === 'server' ? 'client' : 'server')).export({format: 'der', type: 'spki'})
  return {
    options: {
      minVersion: 'TLSv1.3',
      key: key.export({format: 'pem', type: 'pkcs8'}), cert: certificate(key),
      requestCert: role === 'server', rejectUnauthorized: false,
    },
    verifyPeer(socket) {
      try {
        const actual = socket.getPeerX509Certificate()?.publicKey.export({format: 'der', type: 'spki'})
        return Boolean(actual && actual.length === peer.length && timingSafeEqual(actual, peer))
      } catch { return false }
    },
  }
}
