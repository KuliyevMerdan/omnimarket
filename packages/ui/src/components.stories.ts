import type { Meta, StoryObj } from '@storybook/web-components-vite'
import { html } from 'lit'
import { TX_STATUS } from './components/tx-status'

const meta: Meta = { title: 'OmniMarket' }
export default meta

export const Button: StoryObj<{ variant: string; size: string; busy: boolean; disabled: boolean; label: string }> = {
  args: { variant: 'primary', size: 'md', busy: false, disabled: false, label: 'Buy for 0.1 ETH' },
  argTypes: {
    variant: { control: 'inline-radio', options: ['primary', 'secondary', 'ghost'] },
    size: { control: 'inline-radio', options: ['md', 'sm'] },
  },
  render: ({ variant, size, busy, disabled, label }) =>
    html`<omni-button variant=${variant} size=${size} ?busy=${busy} ?disabled=${disabled}>${label}</omni-button>`,
}

export const Address: StoryObj<{ value: string; chars: number }> = {
  args: { value: '0x52908400098527886E0F7030069857D2E4169EE7', chars: 4 },
  render: ({ value, chars }) => html`<omni-address .value=${value} .chars=${chars}></omni-address>`,
}

export const SolanaAddress: StoryObj = {
  render: () => html`<omni-address value="7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV" chars="6"></omni-address>`,
}

export const TxStatuses: StoryObj = {
  render: () =>
    html`<div style="display:flex;gap:8px;flex-wrap:wrap">
      ${Object.keys(TX_STATUS).map((status) => html`<omni-tx-status status=${status}></omni-tx-status>`)}
    </div>`,
}

export const NetworkBadges: StoryObj = {
  render: () => html`<div style="display:flex;gap:8px">
    <omni-network-badge name="Sepolia" state="ok"></omni-network-badge>
    <omni-network-badge name="BNB Chain" state="warn"></omni-network-badge>
    <omni-network-badge name="Solana devnet" state="error"></omni-network-badge>
  </div>`,
}

const ICON =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iOCIgZmlsbD0iIzZkOGJmZiIvPjwvc3ZnPg=='

export const WalletPicker: StoryObj = {
  render: () => html`<div style="display:grid;gap:8px;max-width:360px">
    <omni-wallet-option name="Rabby" icon=${ICON} detail="eip6963"></omni-wallet-option>
    <omni-wallet-option name="Phantom" icon=${ICON} detail="wallet-standard" busy></omni-wallet-option>
    <omni-wallet-option name="Untrusted icon" icon="https://tracker.example/pixel.png" detail="falls back to a letter"></omni-wallet-option>
    <omni-wallet-option name="Unavailable" detail="disabled" disabled></omni-wallet-option>
  </div>`,
}

export const PairingQr: StoryObj<{ value: string }> = {
  args: { value: 'wc:7f6e5d4c3b2a1908f7e6d5c4b3a29180@2?relay-protocol=irn&symKey=0123456789abcdef' },
  render: ({ value }) => html`<omni-qr .value=${value} label="WalletConnect pairing QR code"></omni-qr>`,
}
