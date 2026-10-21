import type { Preview } from '@storybook/web-components-vite'
import '../src/tokens.css'
import '../src/index'

const preview: Preview = {
  tags: ['autodocs'],
  parameters: {
    // Fail the a11y panel on violations instead of only listing them.
    a11y: { test: 'error' },
    backgrounds: { options: { app: { name: 'App', value: 'var(--omni-color-bg)' } } },
  },
  initialGlobals: { backgrounds: { value: 'app' } },
}

export default preview
