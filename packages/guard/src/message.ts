import { hexToBytes, isHex, type Hex } from 'viem'
import { HIDDEN_CHARACTERS } from './chain'
import { buildReport, finding } from './report'
import type { Finding, GuardContext, RiskReport } from './types'

/** EIP-4361 / CAIP-122 first line: `[scheme://]domain wants you to sign in with your … account:`. */
const SIGN_IN_HEADER = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/)?(\S+) wants you to sign in with your .+ account:\r?\n/
const CHAIN_ID_LINE = /^Chain ID: (.+)$/m

/** `personal_sign`. The EIP-191 prefix keeps it from signing a transaction, but not from signing a hash. */
export function inspectMessage(message: string, ctx: GuardContext): RiskReport {
  const decoded = decodeMessage(message)
  if (decoded.kind === 'binary') {
    const hash = decoded.bytes.length === 32
    return buildReport('personal_sign', ctx, {
      intent: { kind: 'hash', hash: message as Hex },
      summary: hash ? 'Sign a hash you can’t read' : 'Sign binary data',
      findings: [
        finding(
          hash ? 'danger' : 'warning',
          'BLIND_SIGNATURE',
          'You can’t see what you’re signing',
          hash
            ? 'A 32-byte hash can stand for an order or a permission somewhere else. Sign it only if you trust the site completely.'
            : 'The message is not text.',
        ),
      ],
      details: [{ label: 'Data', value: message.length > 80 ? `${message.slice(0, 80)}…` : message }],
    })
  }

  const text = decoded.text
  const findings: Finding[] = []
  if (HIDDEN_CHARACTERS.test(text.replace(/[\r\n\t]/g, ''))) {
    findings.push(
      finding('warning', 'HIDDEN_CHARACTERS', 'The message contains invisible characters', 'They can make the text read differently in your wallet than here.'),
    )
  }

  const header = SIGN_IN_HEADER.exec(text)
  if (header) {
    const domain = header[1]!
    if (ctx.domain && domain.toLowerCase() !== ctx.domain.toLowerCase()) {
      findings.push(
        finding(
          'danger',
          'SIGN_IN_DOMAIN_MISMATCH',
          `This signs you in to ${domain}, not ${ctx.domain}`,
          'A site asking you to sign in somewhere else may be taking over your account there.',
        ),
      )
    } else {
      findings.push(finding('info', 'SIGN_IN', `Sign in to ${domain}`, 'No transaction, no gas.'))
    }
    const chain = CHAIN_ID_LINE.exec(text)?.[1]?.trim()
    if (chain && chain !== String(ctx.chainId)) {
      findings.push(finding('warning', 'SIGN_IN_CHAIN_MISMATCH', `The sign-in is for chain ${chain}, you are on ${ctx.chainId}`))
    }
  }

  return buildReport('personal_sign', ctx, {
    intent: { kind: 'message', text, ...(header ? { signIn: { domain: header[1]! } } : {}) },
    summary: header ? `Sign in to ${header[1]}` : 'Sign a message',
    findings,
    details: [],
  })
}

/** `eth_sign` signs raw 32 bytes, a transaction hash included. Nothing in this app needs it. */
export function inspectRawSignature(hash: string, ctx: GuardContext): RiskReport {
  return buildReport('eth_sign', ctx, {
    intent: { kind: 'hash', hash: hash as Hex },
    summary: 'Raw signature (eth_sign)',
    findings: [
      finding('blocked', 'RAW_SIGNATURE', 'eth_sign is blocked', 'It can sign anything, including a transaction that empties your wallet.'),
    ],
    details: [],
  })
}

type Decoded = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'binary'; readonly bytes: Uint8Array }

/** viem and most dApps send hex-encoded UTF-8; some send the plain string. */
function decodeMessage(message: string): Decoded {
  if (!isHex(message)) return { kind: 'text', text: message }
  const bytes = hexToBytes(message)
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    // Mostly control characters: data, not text.
    const control = [...text].filter((c) => /[\u0000-\u0008\u000E-\u001F\u007F]/.test(c)).length
    if (bytes.length > 0 && control / [...text].length < 0.1) return { kind: 'text', text }
  } catch {
    // not UTF-8
  }
  return { kind: 'binary', bytes }
}
